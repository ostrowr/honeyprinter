# Honeyprinter on EC2

Terraform is the selected implementation; CDK remains as a comparison.
The selected AWS account is `316658062409`, local profile `honeyprinter`, in
Oregon (`us-west-2`). The old local login is preserved as `honeyprinter-inactive`.
The [deployment workflow](../.github/workflows/deploy-ec2.yml) builds and deploys
Terraform from `main` when explicitly dispatched. It uses short-lived GitHub OIDC
credentials. The separate application workflow deploys Cloudflare. Shared state and CI access
were bootstrapped separately; normal EC2 deployment happens only through CI.

Start with [`terraform/main.tf`](terraform/main.tf) and
[`cdk/stack.ts`](cdk/stack.ts). Both use the same
[`shared/bootstrap.sh`](shared/bootstrap.sh) and
[`shared/ports.json`](shared/ports.json), so neither hides extra setup in a
different startup script.

## What either version creates

- One `t3.nano` in `us-west-2a`, running standard Amazon Linux 2023 x86-64.
- An isolated VPC, one public subnet, an internet gateway and a route table.
- An auto-assigned public IPv4 address. It changes after stop/start or replacement;
  no Elastic IP is reserved in these basic versions.
- Exactly the 35 implemented TCP ports open to the internet. Port 22 is the decoy;
  the startup script disables the real SSH daemon. Administration uses SSM.
- HTTPS egress for S3, SSM, and Cloudflare. No NAT gateway, load balancer,
  Docker daemon, SSH key pair, or CloudWatch log pipeline.
- An instance role with SSM and private artifact access. Terraform uses the
  pre-bootstrapped `honeyprinter-ec2` profile, which can read release binaries.
  The CDK comparison creates its own role scoped to its selected binary.
- An encrypted 8 GiB gp3 root disk, required IMDSv2, and standard CPU credits.
  Standard credits throttle sustained load instead of charging for surplus credits.
- A checksum-verified binary, a dedicated unprivileged user, and a systemd service
  with only the capability to bind low ports. It restarts on failure.

The shared first-boot script starts in mock mode, with minute summaries in journald.
The EC2 CI workflow then runs [`configure-delivery.ts`](scripts/configure-delivery.ts):
it uploads the Actions ingest secret as an AES256-encrypted object beside the
private release binary, fetches it through the instance role into root-owned
`/etc/honeyprinter.env` (0600), installs a systemd delivery override, and restarts
the service. Terraform state, user data, and SSM command payloads contain no secret
values. The existing release bucket is versioned and retains these private config
objects; its release readers can read them. Only the ingest token is on EC2;
Cloudflare account credentials stay in CI. A changed token requires running both
the Worker and EC2 workflows. The CDK comparison still starts in mock mode.

Both select the AWS-published AL2023 AMI at deployment time. Changing the artifact
key, checksum, or startup script replaces the instance, ensuring installation runs
again. Events in memory and local logs are disposable. An infrastructure operation
finishing does not establish that startup succeeded. The CI job waits for SSM,
checks cloud-init, the running service, the installed checksum, all 35 listeners,
and the disabled real SSH daemon, then probes public SSH/HTTP/HTTPS/Redis decoys.

## Where the complexity goes

| Concern | Terraform | TypeScript CDK |
| --- | --- | --- |
| Main definition | Explicit resource blocks, references, and dependencies | `Vpc` and `Instance` constructs create supporting resources |
| Inputs | Three validated Terraform variables | Three validated CDK context values in `app.ts` |
| State | Existing private S3 bucket, native S3 lock file | CloudFormation-managed stack state |
| One-time setup | S3 state bucket plus the CI deployment role | CDK bootstrap stack plus the CI deployment role |
| Local dependencies | Terraform CLI and AWS provider | Node, CDK CLI/library, TypeScript, and tsx |
| Binary delivery | Existing private S3 object with expected SHA-256 | The same object and checksum |
| Update behavior | `user_data_replace_on_change` | `userDataCausesReplacement` |

CDK's VPC default-security-group cleanup is disabled to match Terraform's unused
default group and avoid adding a custom-resource Lambda solely for this comparison.
The instance uses its explicitly configured decoy security group.

CDK artifact inputs are concrete synthesis-time context values, not CloudFormation
parameters: its replacement hash must change when the binary changes. Otherwise a
parameter-only update can keep the instance and skip the first-boot installer.

## Validate without accessing AWS

Use Terraform 1.10+ (CI pins 1.16.5) and Node 24+. Run from the repo root:

```sh
terraform -chdir=infra/terraform fmt -check -recursive
terraform -chdir=infra/terraform init -backend=false -input=false -lockfile=readonly
terraform -chdir=infra/terraform validate
terraform -chdir=infra/terraform test
bash -n infra/shared/bootstrap.sh

npm --prefix infra/cdk ci
npm --prefix infra/cdk run check
npm --prefix infra/cdk test
npm --prefix infra/cdk run synth:example
```

Dependency installation downloads packages. Terraform tests use a **mock provider**;
CDK synthesis uses **no lookups** and example artifact values. Neither needs an AWS
login. The generated CloudFormation template is
`infra/cdk/cdk.out/Honeyprinter.template.json`.

The checks cover the instance settings, public ports matching the Rust catalog,
restricted download permissions, and instance replacement on a changed CDK artifact.
They do not launch a VM or test Amazon Linux boot.

## Deploy through CI

The [state bucket](bootstrap/README.md) and [CI access/release bucket](ci-bootstrap/README.md)
are provisioned in account `316658062409`, Oregon. Run:

```sh
gh workflow run deploy-ec2.yml --repo ostrowr/honeyprinter --ref main
```

The workflow tests Rust, builds Linux x86-64 with musl, smoke-tests that exact
binary, uploads it to a unique release key, plans and applies Terraform, and
configures Cloudflare delivery, and verifies the running instance and live feed. It does not deploy on push, and does not deploy
Cloudflare. Deployments are serialized. A changed binary, key, or startup script
replaces the instance and changes its public IP; local probe history is disposable.
If verification fails after apply, inspect the existing instance through SSM and
fix the failure; a failed CI check does not automatically destroy infrastructure.

Terraform receives `artifact_bucket`, `artifact_key`, and `artifact_sha256` from
the workflow. The regular CI's GNU/Linux artifact is not used for EC2 because its
glibc may not match Amazon Linux. The dedicated EC2 workflow builds
`x86_64-unknown-linux-musl` and verifies its checksum on the instance.

For local plan examples, see [`example.tfvars`](terraform/example.tfvars). The
CDK comparison takes equivalent `-c artifactBucket=... -c artifactKey=... -c
artifactSha256=...` arguments. Its zero example digest is deliberately not a
deployable binary. CDK remains a comparison and is not deployed.

For Terraform, [`backend.tf`](terraform/backend.tf) names
`honeyprinter-tfstate-316658062409-us-west-2` with an account allowlist and
`honeyprinter/prod.tfstate`, encryption, and `use_lockfile = true`. Both Terraform
backends and providers reject credentials for other accounts. The bucket is
versioned, encrypted, and blocks public access. Grant state/lock permissions only
to the deployment role and authorized administrators, and retain it when removing
the honeypot. No DynamoDB lock table is needed.

If switching to CDK later, bootstrap that account/Region through an explicitly
authorized setup step and use ordinary CloudFormation deployments. No hotswap
or express mode. Keep CDK bootstrap separate from the disposable honeypot stack.

Sources: [Terraform S3 backend](https://developer.hashicorp.com/terraform/language/backend/s3),
[CDK instance properties](https://docs.aws.amazon.com/cdk/api/v2/docs/aws-cdk-lib.aws_ec2.InstanceProps.html),
[SSM Agent on AWS images](https://docs.aws.amazon.com/systems-manager/latest/userguide/ami-preinstalled-agent.html).
