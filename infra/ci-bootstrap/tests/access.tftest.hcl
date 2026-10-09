mock_provider "aws" {
  mock_resource "aws_iam_instance_profile" {
    defaults = { arn = "arn:aws:iam::316658062409:instance-profile/honeyprinter-ec2" }
  }
  mock_resource "aws_iam_role" {
    defaults = { arn = "arn:aws:iam::316658062409:role/honeyprinter-ec2" }
  }
  mock_resource "aws_s3_bucket" {
    defaults = { arn = "arn:aws:s3:::honeyprinter-artifacts-316658062409-us-west-2" }
  }
}

run "ci_is_separate_from_administration" {
  command = apply
  assert {
    condition     = jsondecode(aws_iam_role.deploy.assume_role_policy).Statement[0].Condition.StringEquals["token.actions.githubusercontent.com:sub"] == "repo:ostrowr@3237869/honeyprinter@1410616025:ref:refs/heads/main"
    error_message = "Only this repository's immutable identity on main may deploy."
  }
  assert {
    condition = length([for statement in jsondecode(aws_iam_role_policy.deploy.policy).Statement : statement if statement.Sid == "CreateInsideTaggedVpc"]) == 1 && alltrue([for statement in jsondecode(aws_iam_role_policy.deploy.policy).Statement :
      statement.Condition.StringEquals["aws:ResourceTag/Project"] == "honeyprinter" &&
      toset(statement.Action) == toset(["ec2:CreateSubnet", "ec2:CreateRouteTable", "ec2:CreateSecurityGroup"])
      if statement.Sid == "CreateInsideTaggedVpc"
    ])
    error_message = "Creating a child resource must authorize the existing tagged VPC separately."
  }
  assert {
    condition = alltrue([for statement in jsondecode(aws_iam_role_policy.deploy.policy).Statement :
      alltrue([for action in flatten([statement.Action]) :
        !startswith(action, "iam:") || contains(["iam:GetInstanceProfile", "iam:ListInstanceProfileTags", "iam:PassRole"], action)
      ])
    ])
    error_message = "CI must not create or edit IAM permissions."
  }
  assert {
    condition = (
      !strcontains(aws_iam_role_policy.deploy.policy, "bootstrap/") &&
      !strcontains(aws_iam_role_policy.download.policy, "tfstate") &&
      jsondecode(aws_iam_role_policy.download.policy).Statement[0].Resource == "arn:aws:s3:::honeyprinter-artifacts-316658062409-us-west-2/releases/*" &&
      aws_s3_bucket_public_access_block.artifacts.block_public_policy &&
      aws_s3_bucket_public_access_block.artifacts.restrict_public_buckets &&
      aws_s3_bucket_versioning.artifacts.versioning_configuration[0].status == "Enabled"
    )
    error_message = "Keep private releases separate from state and bootstrap administration."
  }
}
