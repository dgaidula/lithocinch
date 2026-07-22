# Deploying the transform Lambda — a calm, start-to-finish checklist

You already run one AWS service (Route 53), so you have an account and a payment
method — the hard part is done. Everything below is **deletable in one command**
(`sam delete`, Phase 6), and the running cost for this function is **cents, not
dollars** (see Cost, bottom). Read it once top-to-bottom, then work the boxes.

This deploys `lithocinch/lambda/` — a container-image Lambda (arm64) that
takes a POST with an image and returns optimized bytes. It becomes the `remote`
driver for the Lithocinch Craft plugin.

---

## What each AWS thing actually is (node-dev translation)

| AWS term | You already know it as… |
|---|---|
| **IAM user + access keys** | An `.npmrc` token / SSH key, but for the AWS API. Proves "this is Dan's laptop." |
| **CloudFormation** | `package-lock.json` for cloud infra — a declarative manifest of everything to create, created/destroyed as one unit ("a stack"). |
| **SAM** | A thin `npm`-like CLI wrapper over CloudFormation for serverless. `sam deploy` = "npm install, but it builds a Lambda." |
| **ECR** | A private Docker registry (like npm's registry but for images). SAM pushes your built image here automatically. |
| **Lambda Function URL** | A plain HTTPS endpoint for the function — no API Gateway needed. This is the URL you'll `curl` and paste into Lithocinch. |

You do **not** need to touch API Gateway, VPCs, S3, or the console much. SAM does
almost everything from the terminal.

---

## Phase 0 — Safety rails first (5 min, do this before anything)

- [ ] **Set a budget alarm** so a surprise can never sneak up. Console → search
      "Budgets" → *Create budget* → *Zero spend* or a **$5/month** cost budget →
      add your email. This is purely a tripwire; it doesn't cap anything, just
      emails you.
- [ ] Confirm you can log into the AWS console (the account you used for Route 53).
- [ ] Pick a home **region** and use it everywhere. `us-east-1` (N. Virginia) is
      the default-friendliest. Write it down; you'll type it a few times.

> Reassurance: this function costs nothing while idle. Lambda bills only per
> request + compute-millisecond. No servers run 24/7. Deleting the stack removes
> every resource it made.

---

## Phase 1 — Install the three CLIs (10 min)

You almost certainly already have Docker (DDEV uses it). Check, then add the two
AWS CLIs via Homebrew.

- [ ] **Docker running?** `docker info` should print without error. If DDEV works,
      this is already good — just make sure Docker Desktop / Colima is *started*.
- [ ] **AWS CLI:** `brew install awscli` → verify `aws --version`.
- [ ] **AWS SAM CLI:** `brew install aws-sam-cli` → verify `sam --version`.

> Apple-Silicon vs Intel note: Homebrew is `/opt/homebrew` on the M-series minis,
> `/usr/local` on the Intel ones — `brew` handles it, just don't hardcode paths.
> The Lambda image is **arm64** (`template.yaml`), which builds natively on an
> M-series Mac and cross-builds fine on Intel via Docker's emulation.

---

## Phase 2 — Give the CLI credentials (10 min, the one fiddly part)

Create a dedicated IAM user with access keys for deploying. (Solo-dev pragmatic
path; AWS's fancier "Identity Center / SSO" is overkill here.)

- [ ] Console → **IAM** → *Users* → **Create user** (name e.g. `sam-deploy`).
- [ ] **Do NOT** enable console access — this user is for the CLI only.
- [ ] Permissions → *Attach policies directly*. For a first deploy, attach
      **`AdministratorAccess`** to get unblocked, OR (tighter) the set:
      `AWSCloudFormationFullAccess`, `AWSLambda_FullAccess`,
      `AmazonEC2ContainerRegistryFullAccess`, `IAMFullAccess`, `AmazonS3FullAccess`.
      *(You can swap to a least-privilege policy later; note it's a real TODO.)*
- [ ] Create the user → open it → **Security credentials** → *Create access key* →
      choose **Command Line Interface (CLI)** → copy the **Access key ID** and
      **Secret access key** (the secret is shown **once**).
- [ ] Run `aws configure`, paste the two keys, set region = your Phase-0 region,
      output = `json`.
- [ ] **Verify it works:** `aws sts get-caller-identity` should print your account
      ID and the `sam-deploy` user ARN. ✅ This is the "am I connected?" checkpoint.

> Key hygiene: those keys are like a root password to that user. They live in
> `~/.aws/credentials` (already gitignored territory — never commit them). If a key
> ever leaks, delete it in the IAM console; nothing else breaks.

---

## Phase 3 — Deploy (10 min, mostly waiting on the first build)

From `lithocinch/lambda/`:

- [ ] `sam build` — builds the Docker image locally (first run pulls the base
      image; slow once, cached after).
- [ ] `sam deploy --guided` — interactive first deploy. Answer the prompts:
  - **Stack name:** `lithocinch-transform` (any name; this is the CloudFormation unit).
  - **Region:** your Phase-0 region.
  - **Parameter AuthToken:** paste a long random string — this becomes `PI_TOKEN`,
    the bearer token callers must send. Generate one: `openssl rand -hex 24`.
    Save it in your password manager; you'll need it to call the endpoint.
  - **Confirm changes before deploy:** `Y` (see what it'll create).
  - **Allow SAM to create IAM roles:** `Y` (the function's own execution role).
  - **Disable rollback:** `N`.
  - **TransformFunction has no authentication. OK?** `Y` — this is expected. The
    Function URL is public but the handler rejects anything without the correct
    `PI_TOKEN` bearer, so it's guarded.
  - **Save arguments to samconfig.toml:** `Y` — future deploys are just `sam deploy`.
- [ ] SAM creates an ECR repo, pushes the image, creates the Lambda + Function URL.
      When it finishes it prints **`FunctionUrl`** in the Outputs. **Copy that URL.**

---

## Phase 4 — Smoke-test the live endpoint (5 min)

- [ ] Send a real image and confirm optimized bytes come back. Replace the URL,
      token, and a test image path:

  ```bash
  curl -sS -X POST "$FUNCTION_URL" \
    -H "authorization: Bearer $PI_TOKEN" \
    -H "content-type: application/json" \
    -d "$(node -e 'const fs=require("fs");const b=fs.readFileSync(process.argv[1]).toString("base64");process.stdout.write(JSON.stringify({image:b,format:"auto"}))' ~/Downloads/some-image.jpg)" \
    | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{const j=JSON.parse(s);console.log("ok:",j.ok,"format:",j.outputs?.[0]?.format,"bytes:",j.outputs?.[0]?.bytes)})'
  ```

  Request body is `{ image: <base64>, format: "auto" }` (or `ops`/`batch` for
  sized/multi outputs); the response is `{ ok: true, outputs: [{ format, bytes,
  data: <base64> }] }`. A `GET /health` returns `{ ok: true }` with no auth if you
  just want to check the function is alive.

- [ ] Confirm you get bytes back and no `401`. A `401` means the token header is
      wrong; a `403`/CORS error means you hit it from a browser without the header.
- [ ] Note the **cold-start** time on the first call (arm64 + sharp can take a
      couple seconds cold; warm calls are fast). If cold starts feel too slow for
      the plugin, that's a tuning conversation, not a blocker.

---

## Phase 5 — Wire it into Lithocinch (2 min)

- [ ] In the Lithocinch plugin settings (or `config/litho.php`): set `driver = remote`,
      `apiUrl = <FunctionUrl>`, and the API key/token to your `PI_TOKEN`.
- [ ] Load a page that renders an optimized image and confirm it routes through the
      Lambda. Done — the hosted path is live.

---

## Phase 6 — Teardown whenever you want (the anxiety-killer)

- [ ] `sam delete` (from `lambda/`, or `sam delete --stack-name lithocinch-transform`).
      This destroys the Lambda, Function URL, ECR image, and IAM role — the whole
      stack — so billing returns to exactly zero. You can redeploy any time with
      `sam deploy`.

---

## Cost — what you'll actually pay

- **Idle:** $0. Nothing runs between requests.
- **Per request:** Lambda charges per invocation + GB-seconds. At 2048 MB, a
  ~1-second transform is a tiny fraction of a cent. The first **1M requests/month
  and 400,000 GB-seconds are free tier**, so light/dev use is effectively free.
- **Storage:** the ECR image is a few hundred MB — cents/month. `sam delete`
  removes it.
- **The only way to run up a bill** is millions of large transforms; the Phase-0
  budget alarm catches anything unexpected long before it matters.

---

## If something goes wrong (common gotchas)

- **`sam build` fails / "Cannot connect to the Docker daemon"** → Docker Desktop /
  Colima isn't started. Start it, retry.
- **`docker` builds the wrong arch** → the template pins `arm64`; on an Intel Mac
  the cross-build is slower but works. Don't change the arch unless you deploy from
  Intel *and* hit issues — then flip `Architectures: [x86_64]` and bump memory.
- **`ExpiredToken` / `AccessDenied` on deploy** → re-run `aws sts get-caller-identity`;
  if it fails, your keys are wrong/rotated — redo Phase 2's `aws configure`.
- **Deploy hangs pushing the image** → first push to a new ECR repo is slow; let it
  finish. Subsequent deploys only push changed layers.
- **`401` from the endpoint** → the `authorization: Bearer <PI_TOKEN>` header is
  missing or the token doesn't match what you set at deploy. Redeploy with a known
  token via `sam deploy` (it'll reuse `samconfig.toml`; override the parameter if
  needed).

---

*Origin: this design follows the Evil Martians serverless-image-processing pattern
— a container-image Lambda doing sharp transforms behind a simple HTTPS endpoint.*
