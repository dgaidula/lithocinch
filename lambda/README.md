# Deploying the transform Lambda (Lithocinch `remote` driver)

Two handlers live here:

- **`transform.js`** — the synchronous transform API (this guide). The `remote`
  backend for the Craft plugin / any HTTP caller. Bytes in (base64 JSON), bytes
  out. Honors `PI_TOKEN`.
- **`handler.js`** — an S3 object-created batch handler (optimize on upload to a
  bucket). Separate use; deploy similarly if wanted.

## Deploy (AWS SAM, container image)

Prereqs: AWS CLI configured, Docker, [AWS SAM CLI](https://docs.aws.amazon.com/serverless-application-model/).
The container image path is used because it bundles the correct prebuilt sharp
binary for the Lambda platform.

```bash
cd lambda
sam build                       # builds the image from ../ via Dockerfile
sam deploy --guided             # first time: pick region, stack name, etc.
#   when prompted, set AuthToken to a long random string
```

`sam deploy` prints **`FunctionUrl`** — put that in the Craft plugin as `apiUrl`
(driver = `remote`) and the same token as `apiKey`.

Test it:

```bash
TOKEN=... ; URL=...
IMG=$(base64 -i some.jpg | tr -d '\n')
curl -s "$URL" -H "authorization: Bearer $TOKEN" -H 'content-type: application/json' \
  -d "{\"image\":\"$IMG\",\"ops\":{\"width\":800},\"format\":\"auto\"}" | jq '.outputs[0] | {format,width,height,bytes}'
```

## Notes

- **arm64** (Graviton) by default — cheaper and faster. For x86_64, change the
  base image tag in `Dockerfile` to `nodejs:20-x86_64` and
  `Architectures: [x86_64]` in `template.yaml`.
- **Memory 2048 MB / timeout 30s** — sharp/AVIF is CPU-bound and Lambda vCPU
  scales with memory. Tune for your image sizes; raise timeout for the `auto`
  shootout on very large sources.
- **Auth**: `AuthType: NONE` + the `PI_TOKEN` bearer check keeps it simple. For
  production also consider WAF / rate-limiting / a private API Gateway, and
  rotate the token.
- **Cost/bandwidth**: bytes-in/bytes-out means image egress is the main cost
  lever — see RESEARCH/SPEC notes on the SaaS economics.
