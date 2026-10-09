# Terraform state bucket

**Provisioned on 2026-10-08.** The selected account is `316658062409`, using
`AWS_PROFILE=honeyprinter`, in Oregon (`us-west-2`). The user authorized this
one-time state-bucket bootstrap outside CI. This root creates only the bucket and its five configuration resources.
CI access and release storage are managed separately in `../ci-bootstrap`; the
EC2 workflow now supports explicitly authorized deployments. Cloudflare deployment
remains disabled.

The paid-plan upgrade and advanced-feature activation are complete. Management
account `702828429900` uses `awsprojects@ostro.ws`. In organization `o-yunygh1d4i`,
regional SCP `p-ynwjmatb` now exempts Honeyprinter's account from the
`UsWest2Partitional` deny via this additional condition:

```json
"StringNotEquals": { "aws:PrincipalAccount": "316658062409" }
```

The statement's existing Oregon condition and all other statements are unchanged.
This permits existing IAM permissions to work in Oregon; it does not grant IAM
permissions. The organization policy was updated separately in AWS Organizations
and is not managed by this Terraform root.

The bootstrap state has been migrated to S3. A fresh directory initialized the
backend, read all six resources, and produced a no-change plan. Both original Terraform roots successfully initialized their S3 backends during
bootstrap; that operation did not deploy the honeypot.

This separate Terraform root creates only the state bucket and its settings:

- `honeyprinter-tfstate-316658062409-us-west-2` in `us-west-2`.
- Versioning, S3-managed encryption, all four public-access blocks, disabled ACLs,
  and a policy denying non-HTTPS requests.
- `prevent_destroy = true` and no forced deletion of bucket contents.
- No lifecycle expiration of state versions, EC2 instances, IAM roles, or DynamoDB.

Normal S3 storage and request charges apply. This uses no customer-managed KMS key
and does not add paid request metrics, access logging, or CloudTrail data events.
Those audit options can be enabled separately if needed.

The three roots keep separate objects in this bucket:

| Root | State key |
| --- | --- |
| This bucket configuration | `bootstrap/state-bucket.tfstate` |
| CI access and release storage | `bootstrap/ci.tfstate` |
| The honeypot | `honeyprinter/prod.tfstate` |

All use native S3 locking. The honeypot's instance role must have no state access.

## Bootstrap procedure (already completed)

The bucket must exist before an S3 backend can initialize. Once account access and
the execution path are authorized, bootstrap it in a scratch directory containing
only `main.tf` and `.terraform.lock.hcl`. That directory initially uses local state.
Plan and apply **this root only**, then copy `backend.tf` into that directory and
run `terraform init -migrate-state` to move its state into the new bucket. Preserve
the local state until migration and a fresh remote read have succeeded, including
if creation or migration fails midway. Never commit or upload state as a GitHub
artifact. Subsequent runs use the committed S3 backend normally.

The bucket and `allowed_account_ids = ["316658062409"]` are set in
`../terraform/backend.tf`. Both backends and both AWS providers reject credentials
for other accounts. Do not apply the honeypot configuration until separately
authorized.

The user explicitly authorized a one-time local bootstrap of this state bucket
on 2026-10-08. Normal honeypot and Worker deployments must still happen through
CI and require separate deployment authorization.

## Validate without AWS

```sh
terraform -chdir=infra/bootstrap init -backend=false -input=false -lockfile=readonly
terraform -chdir=infra/bootstrap validate
terraform -chdir=infra/bootstrap test
```

Tests use a mocked AWS provider and do not create resources.

[Terraform S3 backend](https://developer.hashicorp.com/terraform/language/backend/s3)
documents locking and the bucket prerequisite;
[backend migration](https://developer.hashicorp.com/terraform/cli/commands/init#backend-initialization)
describes moving the initial state;
[AWS advanced-feature activation](https://docs.aws.amazon.com/accounts/latest/reference/activate-advanced-features.html)
describes the required account transition and regional policy changes.
