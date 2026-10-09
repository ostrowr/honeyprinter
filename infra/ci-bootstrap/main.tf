terraform {
  required_version = ">= 1.10, < 2.0"
  required_providers {
    aws = { source = "hashicorp/aws", version = "~> 6.0" }
  }
  backend "s3" {
    bucket              = "honeyprinter-tfstate-316658062409-us-west-2"
    key                 = "bootstrap/ci.tfstate"
    region              = "us-west-2"
    allowed_account_ids = ["316658062409"]
    encrypt             = true
    use_lockfile        = true
  }
}

provider "aws" {
  region              = "us-west-2"
  allowed_account_ids = ["316658062409"]
  default_tags {
    tags = { Project = "honeyprinter", Purpose = "ci-bootstrap" }
  }
}

locals {
  ec2_prefix = "arn:aws:ec2:us-west-2:316658062409"
  state_arn  = "arn:aws:s3:::honeyprinter-tfstate-316658062409-us-west-2"
  network_resources = [for kind in ["vpc", "subnet", "internet-gateway", "route-table", "security-group"] :
  "${local.ec2_prefix}:${kind}/*"]
}

resource "aws_s3_bucket" "artifacts" {
  bucket        = "honeyprinter-artifacts-316658062409-us-west-2"
  force_destroy = false
  lifecycle { prevent_destroy = true }
}

resource "aws_s3_bucket_public_access_block" "artifacts" {
  bucket                  = aws_s3_bucket.artifacts.id
  block_public_acls       = true
  block_public_policy     = true
  ignore_public_acls      = true
  restrict_public_buckets = true
}

resource "aws_s3_bucket_ownership_controls" "artifacts" {
  bucket = aws_s3_bucket.artifacts.id
  rule { object_ownership = "BucketOwnerEnforced" }
}

resource "aws_s3_bucket_versioning" "artifacts" {
  bucket = aws_s3_bucket.artifacts.id
  versioning_configuration { status = "Enabled" }
}

resource "aws_s3_bucket_server_side_encryption_configuration" "artifacts" {
  bucket = aws_s3_bucket.artifacts.id
  rule {
    apply_server_side_encryption_by_default { sse_algorithm = "AES256" }
  }
}

resource "aws_s3_bucket_policy" "https_only" {
  bucket = aws_s3_bucket.artifacts.id
  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Sid       = "DenyInsecureTransport", Effect = "Deny", Principal = "*", Action = "s3:*"
      Resource  = [aws_s3_bucket.artifacts.arn, "${aws_s3_bucket.artifacts.arn}/*"]
      Condition = { Bool = { "aws:SecureTransport" = "false" } }
    }]
  })
}

# CI can pass this role, but cannot edit IAM or read either bootstrap state.
resource "aws_iam_role" "instance" {
  name = "honeyprinter-ec2"
  assume_role_policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Effect    = "Allow", Action = "sts:AssumeRole"
      Principal = { Service = "ec2.amazonaws.com" }
    }]
  })
}

resource "aws_iam_role_policy_attachment" "ssm" {
  role       = aws_iam_role.instance.name
  policy_arn = "arn:aws:iam::aws:policy/AmazonSSMManagedInstanceCore"
}

resource "aws_iam_role_policy" "download" {
  name = "download-releases"
  role = aws_iam_role.instance.id
  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Effect   = "Allow", Action = "s3:GetObject"
      Resource = "${aws_s3_bucket.artifacts.arn}/releases/*"
    }]
  })
}

resource "aws_iam_instance_profile" "instance" {
  name = "honeyprinter-ec2"
  role = aws_iam_role.instance.name
}

resource "aws_iam_openid_connect_provider" "github" {
  url            = "https://token.actions.githubusercontent.com"
  client_id_list = ["sts.amazonaws.com"]
}

resource "aws_iam_role" "deploy" {
  name                 = "honeyprinter-github-deploy"
  max_session_duration = 3600
  assume_role_policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Effect    = "Allow", Action = "sts:AssumeRoleWithWebIdentity"
      Principal = { Federated = aws_iam_openid_connect_provider.github.arn }
      Condition = { StringEquals = {
        "token.actions.githubusercontent.com:aud" = "sts.amazonaws.com"
        # This repository uses GitHub's immutable owner/repository IDs.
        "token.actions.githubusercontent.com:sub" = "repo:ostrowr@3237869/honeyprinter@1410616025:ref:refs/heads/main"
      } }
    }]
  })
}

resource "aws_iam_role_policy" "deploy" {
  name = "deploy-honeyprinter"
  role = aws_iam_role.deploy.id
  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        Sid       = "ReadEc2AndHealth", Effect = "Allow"
        Action    = ["ec2:Describe*", "ssm:DescribeInstanceInformation", "ssm:GetCommandInvocation"]
        Resource  = "*"
        Condition = { StringEquals = { "aws:RequestedRegion" = "us-west-2" } }
      },
      {
        Sid       = "CreateNetwork", Effect = "Allow"
        Action    = ["ec2:CreateVpc", "ec2:CreateSubnet", "ec2:CreateInternetGateway", "ec2:CreateRouteTable", "ec2:CreateSecurityGroup"]
        Resource  = local.network_resources
        Condition = { StringEquals = { "aws:RequestTag/Project" = "honeyprinter" } }
      },
      {
        # Parent VPC authorization uses existing resource tags, not request tags.
        Sid       = "CreateInsideTaggedVpc", Effect = "Allow"
        Action    = ["ec2:CreateSubnet", "ec2:CreateRouteTable", "ec2:CreateSecurityGroup"]
        Resource  = "${local.ec2_prefix}:vpc/*"
        Condition = { StringEquals = { "aws:ResourceTag/Project" = "honeyprinter" } }
      },
      {
        Sid = "ManageTaggedNetwork", Effect = "Allow"
        Action = [
          "ec2:ModifyVpcAttribute", "ec2:DeleteVpc", "ec2:ModifySubnetAttribute", "ec2:DeleteSubnet",
          "ec2:AttachInternetGateway", "ec2:DetachInternetGateway", "ec2:DeleteInternetGateway",
          "ec2:DeleteRouteTable", "ec2:CreateRoute", "ec2:ReplaceRoute", "ec2:DeleteRoute",
          "ec2:AssociateRouteTable", "ec2:DisassociateRouteTable", "ec2:ReplaceRouteTableAssociation",
          "ec2:DeleteSecurityGroup", "ec2:AuthorizeSecurityGroupIngress", "ec2:AuthorizeSecurityGroupEgress",
          "ec2:RevokeSecurityGroupIngress", "ec2:RevokeSecurityGroupEgress", "ec2:CreateTags", "ec2:DeleteTags"
        ]
        Resource  = local.network_resources
        Condition = { StringEquals = { "aws:ResourceTag/Project" = "honeyprinter" } }
      },
      {
        Sid      = "CreateSecurityGroupRules", Effect = "Allow"
        Action   = ["ec2:AuthorizeSecurityGroupIngress", "ec2:AuthorizeSecurityGroupEgress"]
        Resource = "${local.ec2_prefix}:security-group-rule/*"
      },
      {
        Sid       = "TagNewResources", Effect = "Allow", Action = "ec2:CreateTags"
        Resource  = concat(local.network_resources, ["${local.ec2_prefix}:instance/*", "${local.ec2_prefix}:volume/*", "${local.ec2_prefix}:network-interface/*"])
        Condition = { StringEquals = { "ec2:CreateAction" = ["CreateVpc", "CreateSubnet", "CreateInternetGateway", "CreateRouteTable", "CreateSecurityGroup", "RunInstances"] } }
      },
      {
        Sid      = "LaunchSmallHoneypot", Effect = "Allow", Action = "ec2:RunInstances"
        Resource = "${local.ec2_prefix}:instance/*"
        Condition = { StringEquals = {
          "aws:RequestTag/Project" = "honeyprinter"
          "ec2:InstanceType"       = "t3.nano"
          "ec2:MetadataHttpTokens" = "required"
          "ec2:InstanceProfile"    = aws_iam_instance_profile.instance.arn
        } }
      },
      {
        Sid       = "LaunchInTaggedNetwork", Effect = "Allow", Action = "ec2:RunInstances"
        Resource  = ["${local.ec2_prefix}:subnet/*", "${local.ec2_prefix}:security-group/*"]
        Condition = { StringEquals = { "aws:ResourceTag/Project" = "honeyprinter" } }
      },
      {
        Sid      = "LaunchImageAndNic", Effect = "Allow", Action = "ec2:RunInstances"
        Resource = ["arn:aws:ec2:us-west-2::image/*", "${local.ec2_prefix}:network-interface/*"]
      },
      {
        Sid       = "LaunchEncryptedDisk", Effect = "Allow", Action = "ec2:RunInstances"
        Resource  = "${local.ec2_prefix}:volume/*"
        Condition = { Bool = { "ec2:Encrypted" = "true" } }
      },
      {
        Sid       = "ManageTaggedInstance", Effect = "Allow"
        Action    = ["ec2:TerminateInstances", "ec2:StopInstances", "ec2:StartInstances", "ec2:ModifyInstanceAttribute", "ec2:ModifyInstanceCreditSpecification", "ec2:ModifyInstanceMetadataOptions", "ec2:CreateTags", "ec2:DeleteTags"]
        Resource  = ["${local.ec2_prefix}:instance/*", "${local.ec2_prefix}:volume/*"]
        Condition = { StringEquals = { "aws:ResourceTag/Project" = "honeyprinter" } }
      },
      {
        Sid      = "ReadInstanceProfile", Effect = "Allow"
        Action   = ["iam:GetInstanceProfile", "iam:ListInstanceProfileTags"]
        Resource = aws_iam_instance_profile.instance.arn
      },
      {
        Sid       = "PassOnlyInstanceRole", Effect = "Allow", Action = "iam:PassRole"
        Resource  = aws_iam_role.instance.arn
        Condition = { StringEquals = { "iam:PassedToService" = "ec2.amazonaws.com" } }
      },
      {
        Sid      = "ReadAmazonLinuxAmi", Effect = "Allow", Action = "ssm:GetParameter"
        Resource = "arn:aws:ssm:us-west-2::parameter/aws/service/ami-amazon-linux-latest/al2023-ami-kernel-default-x86_64"
      },
      {
        Sid      = "UseHealthCheckDocument", Effect = "Allow", Action = "ssm:SendCommand"
        Resource = "arn:aws:ssm:us-west-2::document/AWS-RunShellScript"
      },
      {
        Sid       = "CheckTaggedInstance", Effect = "Allow", Action = "ssm:SendCommand"
        Resource  = "${local.ec2_prefix}:instance/*"
        Condition = { StringEquals = { "ssm:resourceTag/Project" = "honeyprinter" } }
      },
      {
        Sid      = "ListStateBucket", Effect = "Allow", Action = "s3:ListBucket"
        Resource = local.state_arn
      },
      {
        Sid      = "HoneypotStateOnly", Effect = "Allow", Action = ["s3:GetObject", "s3:PutObject"]
        Resource = ["${local.state_arn}/honeyprinter/prod.tfstate", "${local.state_arn}/honeyprinter/prod.tfstate.tflock"]
      },
      {
        Sid      = "ReleaseStateLock", Effect = "Allow", Action = "s3:DeleteObject"
        Resource = "${local.state_arn}/honeyprinter/prod.tfstate.tflock"
      },
      {
        Sid      = "PublishReleases", Effect = "Allow", Action = ["s3:PutObject", "s3:GetObject"]
        Resource = "${aws_s3_bucket.artifacts.arn}/releases/*"
      }
    ]
  })
}

output "deployment_role_arn" { value = aws_iam_role.deploy.arn }
output "artifact_bucket" { value = aws_s3_bucket.artifacts.id }
