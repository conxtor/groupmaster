FROM golang:1.22-alpine AS build
WORKDIR /src
COPY apps/api/go.mod apps/api/go.sum* ./
RUN go mod download
COPY apps/api ./
RUN CGO_ENABLED=0 go build -o /out/wagi-api ./cmd/api

FROM gcr.io/distroless/static-debian12
COPY --from=build /out/wagi-api /wagi-api
EXPOSE 8080
ENTRYPOINT ["/wagi-api"]
