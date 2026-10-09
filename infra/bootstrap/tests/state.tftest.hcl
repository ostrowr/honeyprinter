mock_provider "aws" {}

run "private_versioned_backend" {
  command = plan
  assert {
    condition = (
      aws_s3_bucket.state.bucket == "honeyprinter-tfstate-316658062409-us-west-2" &&
      !aws_s3_bucket.state.force_destroy &&
      aws_s3_bucket_public_access_block.state.block_public_acls &&
      aws_s3_bucket_public_access_block.state.block_public_policy &&
      aws_s3_bucket_public_access_block.state.ignore_public_acls &&
      aws_s3_bucket_public_access_block.state.restrict_public_buckets &&
      aws_s3_bucket_ownership_controls.state.rule[0].object_ownership == "BucketOwnerEnforced" &&
      aws_s3_bucket_versioning.state.versioning_configuration[0].status == "Enabled" &&
      one(aws_s3_bucket_server_side_encryption_configuration.state.rule).apply_server_side_encryption_by_default[0].sse_algorithm == "AES256"
    )
    error_message = "The state bucket must stay private, versioned, owner-enforced, and encrypted."
  }
}
