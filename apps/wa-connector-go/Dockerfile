FROM golang:1.25-alpine AS build

WORKDIR /src
COPY apps/wa-connector-go/go.mod apps/wa-connector-go/go.sum* ./
RUN go mod download
COPY apps/wa-connector-go/*.go ./
RUN CGO_ENABLED=0 GOOS=linux GOARCH=amd64 go build -trimpath -ldflags='-s -w' -o /out/wagi-wa-connector-whatsmeow .

FROM alpine:3.22
RUN apk add --no-cache ca-certificates tzdata
COPY --from=build /out/wagi-wa-connector-whatsmeow /usr/local/bin/wagi-wa-connector-whatsmeow
EXPOSE 3001
ENTRYPOINT ["/usr/local/bin/wagi-wa-connector-whatsmeow"]
