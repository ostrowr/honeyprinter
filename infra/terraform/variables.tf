variable "artifact_bucket" {
  description = "Existing private S3 bucket containing the Linux x86-64 musl binary."
  type        = string
  validation {
    condition     = can(regex("^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$", var.artifact_bucket))
    error_message = "Use an S3 bucket name, without a URL or path."
  }
}

variable "artifact_key" {
  description = "Immutable object key, e.g. releases/<commit>/honeyprinter."
  type        = string
  validation {
    condition     = can(regex("^[A-Za-z0-9][A-Za-z0-9/_.-]*$", var.artifact_key))
    error_message = "Use an object key containing only letters, digits, /, _, ., and -."
  }
}

variable "artifact_sha256" {
  description = "SHA-256 of the binary, verified before installation."
  type        = string
  validation {
    condition     = can(regex("^[a-f0-9]{64}$", var.artifact_sha256))
    error_message = "Use a lowercase 64-character SHA-256 digest."
  }
}
