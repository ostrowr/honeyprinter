# These tests use an entirely mocked AWS provider; they never call AWS.
mock_provider "aws" {
  mock_data "aws_ssm_parameter" {
    defaults = { value = "ami-0123456789abcdef0" }
  }
}

variables {
  artifact_bucket = "honeyprinter-artifacts-example"
  artifact_key    = "releases/example/honeyprinter"
  artifact_sha256 = "0000000000000000000000000000000000000000000000000000000000000000"
}

run "honeypot" {
  command = apply

  assert {
    condition = (
      aws_instance.honeypot.instance_type == "t3.nano" &&
      !aws_instance.honeypot.associate_public_ip_address &&
      !aws_subnet.public.map_public_ip_on_launch &&
      aws_eip.honeypot.domain == "vpc" &&
      aws_eip_association.honeypot.allocation_id == aws_eip.honeypot.id &&
      aws_eip_association.honeypot.instance_id == aws_instance.honeypot.id &&
      output.public_ip == aws_eip.honeypot.public_ip &&
      aws_instance.honeypot.user_data_replace_on_change &&
      aws_instance.honeypot.credit_specification[0].cpu_credits == "standard" &&
      aws_instance.honeypot.metadata_options[0].http_tokens == "required" &&
      aws_instance.honeypot.metadata_options[0].http_put_response_hop_limit == 1 &&
      aws_instance.honeypot.root_block_device[0].encrypted &&
      aws_instance.honeypot.root_block_device[0].volume_size == 8
    )
    error_message = "Keep the small instance, public address, replacement behavior, and hardening."
  }
  assert {
    condition = (
      toset([for rule in aws_security_group.decoys.ingress : rule.from_port]) == toset(local.ports) &&
      alltrue([for rule in aws_security_group.decoys.ingress :
        rule.protocol == "tcp" && rule.from_port == rule.to_port &&
      rule.cidr_blocks == tolist(["0.0.0.0/0"])]) &&
      length(aws_security_group.decoys.egress) == 1 &&
      one(aws_security_group.decoys.egress).from_port == 443 &&
      one(aws_security_group.decoys.egress).to_port == 443
    )
    error_message = "Expose only catalog TCP ports with HTTPS egress."
  }
  assert {
    condition = (
      aws_instance.honeypot.iam_instance_profile == "honeyprinter-ec2" &&
      !strcontains(local.user_data, "@ARTIFACT_") &&
      strcontains(local.user_data, "sha256sum --check") &&
      strcontains(local.user_data, "systemctl disable --now sshd.service") &&
      !strcontains(local.user_data, "--ingest-url")
    )
    error_message = "Use the pre-bootstrapped instance profile and render the mock-queue startup script."
  }
}
