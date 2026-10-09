terraform {
  # Initial creation must use a scratch copy of main.tf without this backend.
  # After creation, migrate that state here; see README.md.
  backend "s3" {
    bucket              = "honeyprinter-tfstate-316658062409-us-west-2"
    key                 = "bootstrap/state-bucket.tfstate"
    region              = "us-west-2"
    allowed_account_ids = ["316658062409"]
    encrypt             = true
    use_lockfile        = true
  }
}
