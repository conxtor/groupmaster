package main

import (
	"bytes"
	"context"
	"fmt"
	"io"
	"log"
	"net/http"
	"net/url"
	"sort"
	"strings"
	"time"
)

// mediaBucketConfig is deliberately isolated from the normal media API. It
// makes the one-time legacy migration removable without changing the media
// serving or upload contracts again.
type mediaBucketConfig struct {
	Legacy    string
	Images    string
	Videos    string
	Audio     string
	Documents string
	Other     string
}

func newMediaBucketConfig() mediaBucketConfig {
	return mediaBucketConfig{
		Legacy:    env("MINIO_BUCKET", "wa-media"),
		Images:    env("MINIO_BUCKET_IMAGES", "wa-media-images"),
		Videos:    env("MINIO_BUCKET_VIDEOS", "wa-media-videos"),
		Audio:     env("MINIO_BUCKET_AUDIO", "wa-media-audio"),
		Documents: env("MINIO_BUCKET_DOCUMENTS", "wa-media-documents"),
		Other:     env("MINIO_BUCKET_OTHER", "wa-media-other"),
	}
}

func (c mediaBucketConfig) all() []string {
	values := []string{c.Images, c.Videos, c.Audio, c.Documents, c.Other}
	seen := make(map[string]struct{}, len(values))
	result := make([]string, 0, len(values))
	for _, value := range values {
		value = strings.TrimSpace(value)
		if value == "" || value == c.Legacy {
			continue
		}
		if _, ok := seen[value]; ok {
			continue
		}
		seen[value] = struct{}{}
		result = append(result, value)
	}
	return result
}

func (c mediaBucketConfig) forMedia(kind, mediaMime string) string {
	normalizedKind := strings.ToLower(strings.TrimSpace(kind))
	normalizedMime := strings.ToLower(strings.TrimSpace(strings.Split(mediaMime, ";")[0]))
	switch {
	case normalizedKind == "image" || strings.HasPrefix(normalizedMime, "image/"):
		return c.Images
	case normalizedKind == "video" || strings.HasPrefix(normalizedMime, "video/"):
		return c.Videos
	case normalizedKind == "audio" || strings.HasPrefix(normalizedMime, "audio/"):
		return c.Audio
	case normalizedKind == "document" || strings.HasPrefix(normalizedMime, "application/") || strings.HasPrefix(normalizedMime, "text/"):
		return c.Documents
	default:
		return c.Other
	}
}

type mediaObjectMigrationRow struct {
	ID           string
	Bucket       *string
	ObjectKey    *string
	ThumbnailKey *string
	Kind         string
	MediaMime    string
	StoredMime   string
}

// migrateMediaBuckets is the only call site for the removable startup
// migration. It is idempotent: copy first, persist the target bucket second,
// then remove the legacy object. A crash at any point is safe to resume.
func (a *app) migrateMediaBuckets(ctx context.Context) error {
	if !a.mediaBucketMigrationEnabled {
		return nil
	}
	legacy := strings.TrimSpace(a.minioBucket)
	if legacy == "" || len(a.minioBuckets.all()) == 0 {
		return nil
	}
	if err := a.ensureConfiguredMediaBuckets(ctx); err != nil {
		return fmt.Errorf("media bucket migration: ensure target buckets failed: %w", err)
	}
	legacyExists, err := a.minioBucketExists(ctx, legacy)
	if err != nil {
		return fmt.Errorf("media bucket migration: legacy bucket check failed: %w", err)
	}
	if !legacyExists {
		return nil
	}

	rows, err := a.db.Query(ctx, `
		SELECT mo.id::text, mo.bucket, mo.object_key, mo.thumbnail_key,
		       COALESCE(m.kind, ''), COALESCE(m.media_mime, ''), COALESCE(mo.mime, '')
		FROM media_objects mo
		JOIN messages m ON m.id = mo.message_id
		WHERE mo.bucket IS NULL OR mo.bucket = $1
		ORDER BY mo.created_at, mo.id`, legacy)
	if err != nil {
		return fmt.Errorf("media bucket migration: query failed: %w", err)
	}
	defer rows.Close()

	migrated := 0
	createdBuckets := make(map[string]bool)
	for rows.Next() {
		var item mediaObjectMigrationRow
		if err := rows.Scan(&item.ID, &item.Bucket, &item.ObjectKey, &item.ThumbnailKey, &item.Kind, &item.MediaMime, &item.StoredMime); err != nil {
			return fmt.Errorf("media bucket migration: row scan failed: %w", err)
		}
		target := a.minioBuckets.forMedia(item.Kind, firstNonEmpty(item.MediaMime, item.StoredMime))
		if target == "" || target == legacy {
			continue
		}
		if !createdBuckets[target] {
			if err := a.ensureMinIOBucket(ctx, target); err != nil {
				return fmt.Errorf("media bucket migration: ensure %s failed: %w", target, err)
			}
			createdBuckets[target] = true
		}

		if item.ObjectKey != nil && strings.TrimSpace(*item.ObjectKey) != "" {
			if err := a.copyMinIOObject(ctx, legacy, target, *item.ObjectKey); err != nil {
				return fmt.Errorf("media bucket migration: copy %s/%s to %s failed: %w", legacy, *item.ObjectKey, target, err)
			}
		}
		if item.ThumbnailKey != nil && strings.TrimSpace(*item.ThumbnailKey) != "" {
			if err := a.copyMinIOObject(ctx, legacy, target, *item.ThumbnailKey); err != nil {
				return fmt.Errorf("media bucket migration: copy thumbnail %s/%s to %s failed: %w", legacy, *item.ThumbnailKey, target, err)
			}
		}
		if _, err := a.db.Exec(ctx, `UPDATE media_objects SET bucket=$1, updated_at=NOW() WHERE id=$2::uuid AND (bucket IS NULL OR bucket=$3)`, target, item.ID, legacy); err != nil {
			return fmt.Errorf("media bucket migration: update reference %s failed: %w", item.ID, err)
		}
		if item.ObjectKey != nil && strings.TrimSpace(*item.ObjectKey) != "" {
			if err := a.deleteMinIOObject(ctx, legacy, *item.ObjectKey); err != nil {
				return fmt.Errorf("media bucket migration: delete legacy object %s/%s failed: %w", legacy, *item.ObjectKey, err)
			}
		}
		if item.ThumbnailKey != nil && strings.TrimSpace(*item.ThumbnailKey) != "" {
			if err := a.deleteMinIOObject(ctx, legacy, *item.ThumbnailKey); err != nil {
				return fmt.Errorf("media bucket migration: delete legacy thumbnail %s/%s failed: %w", legacy, *item.ThumbnailKey, err)
			}
		}
		migrated++
	}
	if err := rows.Err(); err != nil {
		return fmt.Errorf("media bucket migration: row iteration failed: %w", err)
	}
	if migrated > 0 {
		log.Printf("media bucket migration moved %d media reference(s) from %s", migrated, legacy)
	}
	return nil
}

func (a *app) ensureConfiguredMediaBuckets(ctx context.Context) error {
	for _, bucket := range a.minioBuckets.all() {
		if err := a.ensureMinIOBucket(ctx, bucket); err != nil {
			return fmt.Errorf("ensure %s: %w", bucket, err)
		}
	}
	return nil
}

func firstNonEmpty(values ...string) string {
	for _, value := range values {
		if strings.TrimSpace(value) != "" {
			return value
		}
	}
	return ""
}

func (a *app) minioBucketExists(ctx context.Context, bucket string) (bool, error) {
	response, err := a.minioRequest(ctx, http.MethodHead, bucket, "", nil, nil)
	if err != nil {
		return false, err
	}
	defer response.Body.Close()
	if response.StatusCode == http.StatusNotFound {
		return false, nil
	}
	if response.StatusCode < http.StatusOK || response.StatusCode >= http.StatusMultipleChoices {
		return false, minioResponseError(response)
	}
	return true, nil
}

func (a *app) ensureMinIOBucket(ctx context.Context, bucket string) error {
	exists, err := a.minioBucketExists(ctx, bucket)
	if err != nil {
		return err
	}
	if exists {
		return nil
	}
	response, err := a.minioRequest(ctx, http.MethodPut, bucket, "", nil, nil)
	if err != nil {
		return err
	}
	defer response.Body.Close()
	if response.StatusCode != http.StatusOK && response.StatusCode != http.StatusCreated && response.StatusCode != http.StatusNoContent {
		return minioResponseError(response)
	}
	return nil
}

func (a *app) copyMinIOObject(ctx context.Context, sourceBucket, targetBucket, objectKey string) error {
	copySource := "/" + awsMinIOEncode(sourceBucket) + "/" + awsMinIOEncode(objectKey)
	headers := http.Header{}
	headers.Set("x-amz-copy-source", copySource)
	response, err := a.minioRequest(ctx, http.MethodPut, targetBucket, objectKey, headers, nil)
	if err != nil {
		return err
	}
	defer response.Body.Close()
	if response.StatusCode < http.StatusOK || response.StatusCode >= http.StatusMultipleChoices {
		return minioResponseError(response)
	}
	return nil
}

func (a *app) deleteMinIOObject(ctx context.Context, bucket, objectKey string) error {
	response, err := a.minioRequest(ctx, http.MethodDelete, bucket, objectKey, nil, nil)
	if err != nil {
		return err
	}
	defer response.Body.Close()
	if response.StatusCode != http.StatusNoContent && response.StatusCode != http.StatusOK {
		return minioResponseError(response)
	}
	return nil
}

func (a *app) minioRequest(ctx context.Context, method, bucket, objectKey string, headers http.Header, body []byte) (*http.Response, error) {
	return a.minioRequestQuery(ctx, method, bucket, objectKey, nil, headers, body)
}

func (a *app) minioRequestQuery(ctx context.Context, method, bucket, objectKey string, query url.Values, headers http.Header, body []byte) (*http.Response, error) {
	endpoint, err := url.Parse(a.minioEndpoint)
	if err != nil || endpoint.Scheme == "" || endpoint.Host == "" {
		return nil, fmt.Errorf("ungültiger MinIO-Endpoint")
	}
	if a.minioAccessKey == "" || a.minioSecretKey == "" {
		return nil, fmt.Errorf("MinIO-Zugangsdaten fehlen")
	}
	requestURL := *endpoint
	requestURL.Path = strings.TrimRight(endpoint.Path, "/") + "/" + strings.Trim(bucket, "/")
	if strings.Trim(objectKey, "/") != "" {
		requestURL.Path += "/" + strings.TrimLeft(objectKey, "/")
	}
	requestURL.RawQuery = canonicalMinIOQuery(query)
	if headers == nil {
		headers = http.Header{}
	}
	if body == nil {
		body = []byte{}
	}
	payloadHash := sha256Hex(body)
	now := time.Now().UTC()
	headers.Set("x-amz-content-sha256", payloadHash)
	headers.Set("x-amz-date", now.Format("20060102T150405Z"))

	canonicalHeaderValues := map[string]string{"host": requestURL.Host}
	for key, values := range headers {
		lower := strings.ToLower(key)
		if lower == "authorization" || lower == "host" {
			continue
		}
		canonicalHeaderValues[lower] = strings.TrimSpace(strings.Join(values, ","))
	}
	keys := make([]string, 0, len(canonicalHeaderValues))
	for key := range canonicalHeaderValues {
		keys = append(keys, key)
	}
	sort.Strings(keys)
	canonicalHeaders := strings.Builder{}
	for _, key := range keys {
		canonicalHeaders.WriteString(key)
		canonicalHeaders.WriteByte(':')
		canonicalHeaders.WriteString(canonicalHeaderValues[key])
		canonicalHeaders.WriteByte('\n')
	}
	signedHeaders := strings.Join(keys, ";")
	canonicalRequest := strings.Join([]string{method, requestURL.EscapedPath(), requestURL.RawQuery, canonicalHeaders.String(), signedHeaders, payloadHash}, "\n")
	date := now.Format("20060102")
	credentialScope := date + "/" + minioSigningRegion + "/s3/aws4_request"
	stringToSign := strings.Join([]string{"AWS4-HMAC-SHA256", now.Format("20060102T150405Z"), credentialScope, sha256Hex([]byte(canonicalRequest))}, "\n")
	signingKey := hmacSHA256(hmacSHA256(hmacSHA256(hmacSHA256([]byte("AWS4"+a.minioSecretKey), []byte(date)), []byte(minioSigningRegion)), []byte("s3")), []byte("aws4_request"))
	signature := hmacSHA256Hex(signingKey, []byte(stringToSign))

	request, err := http.NewRequestWithContext(ctx, method, requestURL.String(), bytes.NewReader(body))
	if err != nil {
		return nil, err
	}
	for key, values := range headers {
		for _, value := range values {
			request.Header.Add(key, value)
		}
	}
	request.Header.Set("Authorization", "AWS4-HMAC-SHA256 Credential="+a.minioAccessKey+"/"+credentialScope+", SignedHeaders="+signedHeaders+", Signature="+signature)
	return (&http.Client{Timeout: 30 * time.Second}).Do(request)
}

func minioResponseError(response *http.Response) error {
	body, _ := io.ReadAll(io.LimitReader(response.Body, 2048))
	detail := strings.TrimSpace(string(body))
	if detail == "" {
		detail = response.Status
	}
	return fmt.Errorf("MinIO antwortete mit %s: %s", response.Status, detail)
}
