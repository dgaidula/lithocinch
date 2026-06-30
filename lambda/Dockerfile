# Container image for the transform Lambda (the Crisp `remote` driver).
# Building on the matching Lambda base image gets the correct prebuilt sharp
# binary for the platform — the reliable path for native deps on Lambda.
#
# arm64 (Graviton, cheaper/faster) by default. For x86_64, swap the base tag to
# nodejs:20-x86_64 and set Architectures: [x86_64] in template.yaml.
FROM public.ecr.aws/lambda/nodejs:20-arm64

# Install production deps first (layer cache). Building inside the arm64 Linux
# base means `npm ci` resolves sharp's linux-arm64 prebuilt automatically.
COPY package.json package-lock.json ./
RUN npm ci --omit=dev

# App code (package.json above already sets "type":"module" for the ESM handler).
COPY src ./src
COPY lambda ./lambda

# <file>.<exportedHandler>
CMD [ "lambda/transform.handler" ]
