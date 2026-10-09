terraform {
  required_version = ">= 1.10, < 2.0"
  required_providers {
    aws = {
      source  = "hashicorp/aws"
      version = "~> 6.0"
    }
  }

  # The separately bootstrapped state bucket is shared with the bootstrap root.
  backend "s3" {
    bucket              = "honeyprinter-tfstate-316658062409-us-west-2"
    allowed_account_ids = ["316658062409"]
    key                 = "honeyprinter/prod.tfstate"
    region              = "us-west-2"
    encrypt             = true
    use_lockfile        = true
  }
}
