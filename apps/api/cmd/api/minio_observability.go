package main

import (
	"context"
	"crypto/hmac"
	"crypto/sha256"
	"encoding/hex"
	"encoding/xml"
	"fmt"
	"io"
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

func (a *app) collectMinIOObservability(parent context.Context) minioObservabilityView {
	view := minioObservabilityView{Endpoint: a.minioEndpoint, Bucket: a.minioBucket}
	ctx, cancel := context.WithTimeout(parent, 8*time.Second)
	defer cancel()

	if strings.TrimSpace(a.minioEndpoint) == "" || strings.TrimSpace(a.minioBucket) == "" {
		view.Error = "MinIO ist nicht konfiguriert"
		return view
	}

	continuationToken := ""
	for page := 0; page < 101; page++ {
		result, err := a.listMinIOObjects(ctx, continuationToken)
		if err != nil {
			view.Error = err.Error()
			return view
		}
		view.Connected = true
		view.BucketExists = true
		for _, object := range result.Contents {
			view.ObjectCount++
			view.TotalBytes += object.Size
			if view.LastModified == nil || object.LastModified.After(*view.LastModified) {
				lastModified := object.LastModified
				view.LastModified = &lastModified
			}
		}
		if !result.IsTruncated || result.NextContinuationToken == "" {
			return view
		}
		continuationToken = result.NextContinuationToken
	}
	view.Error = "MinIO-Bestand ist größer als die Observability-Abfragegrenze von 100.000 Objekten"
	return view
}

func (a *app) listMinIOObjects(ctx context.Context, continuationToken string) (minioListBucketResult, error) {
	var result minioListBucketResult
	endpoint, err := url.Parse(a.minioEndpoint)
	if err != nil || endpoint.Scheme == "" || endpoint.Host == "" {
		return result, fmt.Errorf("ungültiger MinIO-Endpoint")
	}
	if a.minioAccessKey == "" || a.minioSecretKey == "" {
		return result, fmt.Errorf("MinIO-Zugangsdaten fehlen")
	}

	requestURL := *endpoint
	requestURL.Path = strings.TrimRight(endpoint.Path, "/") + "/" + a.minioBucket
	requestURL.RawPath = ""
	query := url.Values{"list-type": []string{"2"}}
	if continuationToken != "" {
		query.Set("continuation-token", continuationToken)
	}
	requestURL.RawQuery = canonicalMinIOQuery(query)

	now := time.Now().UTC()
	payloadHash := sha256Hex(nil)
	canonicalURI := requestURL.EscapedPath()
	if canonicalURI == "" {
		canonicalURI = "/"
	}
	canonicalHeaders := "host:" + requestURL.Host + "\n" +
		"x-amz-content-sha256:" + payloadHash + "\n" +
		"x-amz-date:" + now.Format("20060102T150405Z") + "\n"
	signedHeaders := "host;x-amz-content-sha256;x-amz-date"
	canonicalRequest := strings.Join([]string{
		http.MethodGet,
		canonicalURI,
		requestURL.RawQuery,
		canonicalHeaders,
		signedHeaders,
		payloadHash,
	}, "\n")
	date := now.Format("20060102")
	credentialScope := date + "/" + minioSigningRegion + "/s3/aws4_request"
	stringToSign := strings.Join([]string{
		"AWS4-HMAC-SHA256",
		now.Format("20060102T150405Z"),
		credentialScope,
		sha256Hex([]byte(canonicalRequest)),
	}, "\n")
	signingKey := hmacSHA256(
		hmacSHA256(
			hmacSHA256(
				hmacSHA256([]byte("AWS4"+a.minioSecretKey), []byte(date)),
				[]byte(minioSigningRegion),
			),
			[]byte("s3"),
		),
		[]byte("aws4_request"),
	)
	signature := hmacSHA256Hex(signingKey, []byte(stringToSign))

	req, err := http.NewRequestWithContext(ctx, http.MethodGet, requestURL.String(), nil)
	if err != nil {
		return result, fmt.Errorf("MinIO-Anfrage konnte nicht erstellt werden: %w", err)
	}
	req.Header.Set("x-amz-content-sha256", payloadHash)
	req.Header.Set("x-amz-date", now.Format("20060102T150405Z"))
	req.Header.Set("Authorization", "AWS4-HMAC-SHA256 Credential="+a.minioAccessKey+"/"+credentialScope+", SignedHeaders="+signedHeaders+", Signature="+signature)

	response, err := (&http.Client{Timeout: 7 * time.Second}).Do(req)
	if err != nil {
		return result, fmt.Errorf("MinIO nicht erreichbar: %w", err)
	}
	defer response.Body.Close()
	if response.StatusCode < http.StatusOK || response.StatusCode >= http.StatusMultipleChoices {
		body, _ := io.ReadAll(io.LimitReader(response.Body, 2048))
		detail := strings.TrimSpace(string(body))
		if detail == "" {
			detail = response.Status
		}
		return result, fmt.Errorf("MinIO-Bucket konnte nicht gelesen werden: %s", detail)
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
