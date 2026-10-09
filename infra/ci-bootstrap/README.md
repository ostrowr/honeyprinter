# CI access and release storage

This root bootstraps the private release bucket, GitHub OIDC provider/deployment
role, and EC2 instance profile. It was applied locally on 2026-10-08 as the
one-time prerequisite for the authorized CI deployment. Its state is stored at
`bootstrap/ci.tfstate` in the existing state bucket.

The deployment role trusts only the immutable identity of `ostrowr/honeyprinter`
on `main`. It can manage Honeyprinter-tagged networking and instances in Oregon,
launch `t3.nano` instances with IMDSv2 and encrypted volumes, pass only the
`honeyprinter-ec2` role, upload releases, and manage `honeyprinter/prod.tfstate`
and its lock. Systems Manager commands are limited to Honeyprinter-tagged nodes.
It cannot edit IAM, read bootstrap state, or delete state objects or releases.

The EC2 role has Systems Manager access and read-only access to `releases/*` in
`honeyprinter-artifacts-316658062409-us-west-2`. It has no Terraform state access.
The bucket blocks public access, disables ACLs, requires HTTPS, uses SSE-S3, and
retains object versions. Each CI run publishes to a new commit/run/attempt key
with a conditional write and verifies the binary's SHA-256 before installation.

Administrators manage this root using `AWS_PROFILE=honeyprinter`. Routine EC2
deployments use `.github/workflows/deploy-ec2.yml`; that role deliberately cannot
apply this root or the state-bucket root. No AWS access keys are stored in GitHub.

Validate without AWS:

```sh
terraform -chdir=infra/ci-bootstrap init -backend=false -lockfile=readonly
terraform -chdir=infra/ci-bootstrap validate
terraform -chdir=infra/ci-bootstrap test
```

The mock tests check repository trust, IAM separation, and release/state isolation.
