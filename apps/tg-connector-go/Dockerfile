FROM golang:1.25-alpine AS build

RUN apk add --no-cache ca-certificates git
WORKDIR /src

COPY apps/tg-connector-go/go.mod apps/tg-connector-go/go.sum ./apps/tg-connector-go/
WORKDIR /src/apps/tg-connector-go
RUN go mod download

COPY apps/tg-connector-go/ ./
# gotd generates a large tg package. Serial compilation keeps the local
# Colima build within small development VM memory limits.
RUN CGO_ENABLED=0 GOOS=linux GOARCH=amd64 go build -p=1 -trimpath -ldflags="-s -w" -o /out/wagi-tg-connector .

FROM alpine:3.20
RUN apk add --no-cache ca-certificates
COPY --from=build /out/wagi-tg-connector /wagi-tg-connector
EXPOSE 3002
ENTRYPOINT ["/wagi-tg-connector"]
