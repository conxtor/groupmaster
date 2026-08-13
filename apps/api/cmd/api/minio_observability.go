package main

import (
	"context"
	"crypto/hmac"
	"crypto/sha256"
	"encoding/hex"
	"encoding/xml"
	"fmt"
	"net/http"
	"net/url"
	"sort"
	"strings"
	"time"
)

const minioSigningRegion = "us-east-1"

type minioListBucketResult struct {
	IsTruncated           bool   `xml:"IsTruncated"`
	NextContinuationToken string `xml:"NextContinuationToken"`
	Contents              []struct {
		LastModified time.Time `xml:"LastModified"`
		Size         int64     `xml:"Size"`
	} `xml:"Contents"`
}

type minioBucketObservabilityView struct {
	Bucket       string     `json:"bucket"`
	Connected    bool       `json:"connected"`
	BucketExists bool       `json:"bucketExists"`
	ObjectCount  int64      `json:"objectCount"`
	TotalBytes   int64      `json:"totalBytes"`
	LastModified *time.Time `json:"lastModified,omitempty"`
	Error        string     `json:"error,omitempty"`
}

func (a *app) collectMinIOObservability(parent context.Context) minioObservabilityView {
	view := minioObservabilityView{Endpoint: a.minioEndpoint, Bucket: a.minioBucket, Buckets: make([]minioBucketObservabilityView, 0)}
	ctx, cancel := context.WithTimeout(parent, 8*time.Second)
	defer cancel()

	if strings.TrimSpace(a.minioEndpoint) == "" || strings.TrimSpace(a.minioBucket) == "" {
		view.Error = "MinIO ist nicht konfiguriert"
		return view
	}
	buckets := append([]string{a.minioBucket}, a.minioBuckets.all()...)
	seen := make(map[string]struct{}, len(buckets))
	for _, bucket := range buckets {
		if _, ok := seen[bucket]; ok || strings.TrimSpace(bucket) == "" {
			continue
		}
		seen[bucket] = struct{}{}
		bucketView := minioBucketObservabilityView{Bucket: bucket}
		continuationToken := ""
		for page := 0; page < 101; page++ {
			result, err := a.listMinIOObjects(ctx, bucket, continuationToken)
			if err != nil {
				bucketView.Error = err.Error()
				break
			}
			bucketView.Connected = true
			bucketView.BucketExists = true
			view.Connected = true
			view.BucketExists = true
			for _, object := range result.Contents {
				bucketView.ObjectCount++
				bucketView.TotalBytes += object.Size
				if bucketView.LastModified == nil || object.LastModified.After(*bucketView.LastModified) {
					lastModified := object.LastModified
					bucketView.LastModified = &lastModified
				}
			}
			if !result.IsTruncated || result.NextContinuationToken == "" {
				break
			}
			continuationToken = result.NextContinuationToken
		}
		if bucketView.Error != "" && view.Error == "" {
			view.Error = bucketView.Error
		}
		view.ObjectCount += bucketView.ObjectCount
		view.TotalBytes += bucketView.TotalBytes
		if bucketView.LastModified != nil && (view.LastModified == nil || bucketView.LastModified.After(*view.LastModified)) {
			lastModified := *bucketView.LastModified
			view.LastModified = &lastModified
		}
		view.Buckets = append(view.Buckets, bucketView)
	}
	return view
}

func (a *app) listMinIOObjects(ctx context.Context, bucket, continuationToken string) (minioListBucketResult, error) {
	var result minioListBucketResult
	query := url.Values{"list-type": []string{"2"}}
	if continuationToken != "" {
		query.Set("continuation-token", continuationToken)
	}
	response, err := a.minioRequestQuery(ctx, http.MethodGet, bucket, "", query, nil, nil)
	if err != nil {
		return result, err
	}
	defer response.Body.Close()
	if response.StatusCode < http.StatusOK || response.StatusCode >= http.StatusMultipleChoices {
		return result, minioResponseError(response)
	}
	if err := xml.NewDecoder(response.Body).Decode(&result); err != nil {
		return result, fmt.Errorf("MinIO-Antwort konnte nicht gelesen werden: %w", err)
	}
	return result, nil
}

func canonicalMinIOQuery(values url.Values) string {
	type pair struct{ key, value string }
	pairs := make([]pair, 0)
	for key, items := range values {
		for _, value := range items {
			pairs = append(pairs, pair{key: awsMinIOEncode(key), value: awsMinIOEncode(value)})
		}
	}
	sort.Slice(pairs, func(i, j int) bool {
		if pairs[i].key == pairs[j].key {
			return pairs[i].value < pairs[j].value
		}
		return pairs[i].key < pairs[j].key
	})
	parts := make([]string, len(pairs))
	for i, item := range pairs {
		parts[i] = item.key + "=" + item.value
	}
	return strings.Join(parts, "&")
}

func awsMinIOEncode(value string) string {
	const hexChars = "0123456789ABCDEF"
	var builder strings.Builder
	for i := 0; i < len(value); i++ {
		character := value[i]
		if (character >= 'A' && character <= 'Z') || (character >= 'a' && character <= 'z') || (character >= '0' && character <= '9') || character == '-' || character == '_' || character == '.' || character == '~' {
			builder.WriteByte(character)
			continue
		}
		builder.WriteByte('%')
		builder.WriteByte(hexChars[character>>4])
		builder.WriteByte(hexChars[character&0x0f])
	}
	return builder.String()
}

func sha256Hex(value []byte) string {
	digest := sha256.Sum256(value)
	return hex.EncodeToString(digest[:])
}

func hmacSHA256(key, value []byte) []byte {
	h := hmac.New(sha256.New, key)
	_, _ = h.Write(value)
	return h.Sum(nil)
}

func hmacSHA256Hex(key, value []byte) string {
	return hex.EncodeToString(hmacSHA256(key, value))
}
