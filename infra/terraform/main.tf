provider "aws" {
  region              = "us-west-2"
  allowed_account_ids = ["316658062409"]
  default_tags {
    tags = { Project = "honeyprinter", Implementation = "terraform" }
  }
}

locals {
  ports = jsondecode(file("${path.module}/../shared/ports.json"))
  user_data = replace(replace(replace(
    file("${path.module}/../shared/bootstrap.sh"),
    "@ARTIFACT_BUCKET@", var.artifact_bucket),
    "@ARTIFACT_KEY@", var.artifact_key),
  "@ARTIFACT_SHA256@", var.artifact_sha256)
}

resource "aws_vpc" "honeypot" {
  cidr_block           = "10.77.0.0/16"
  enable_dns_support   = true
  enable_dns_hostnames = true
}

resource "aws_subnet" "public" {
  vpc_id                  = aws_vpc.honeypot.id
  cidr_block              = "10.77.0.0/24"
  availability_zone       = "us-west-2a"
  map_public_ip_on_launch = true
}

resource "aws_internet_gateway" "public" {
  vpc_id = aws_vpc.honeypot.id
}

resource "aws_route_table" "public" {
  vpc_id = aws_vpc.honeypot.id
  route {
    cidr_block = "0.0.0.0/0"
    gateway_id = aws_internet_gateway.public.id
  }
}

resource "aws_route_table_association" "public" {
  subnet_id      = aws_subnet.public.id
  route_table_id = aws_route_table.public.id
}

resource "aws_security_group" "decoys" {
  description = "Public TCP decoys; port 22 is a fake SSH service"
  vpc_id      = aws_vpc.honeypot.id
  dynamic "ingress" {
    for_each = local.ports
    content {
      protocol    = "tcp"
      from_port   = ingress.value
      to_port     = ingress.value
      cidr_blocks = ["0.0.0.0/0"]
    }
  }
  egress {
    description = "HTTPS for S3, SSM, and future Cloudflare delivery"
    protocol    = "tcp"
    from_port   = 443
    to_port     = 443
    cidr_blocks = ["0.0.0.0/0"]
  }
}

data "aws_iam_instance_profile" "instance" {
  name = "honeyprinter-ec2"
}

data "aws_ssm_parameter" "ami" {
  name = "/aws/service/ami-amazon-linux-latest/al2023-ami-kernel-default-x86_64"
}

resource "aws_instance" "honeypot" {
  ami                         = data.aws_ssm_parameter.ami.value
  instance_type               = "t3.nano"
  subnet_id                   = aws_subnet.public.id
  vpc_security_group_ids      = [aws_security_group.decoys.id]
  associate_public_ip_address = true
  iam_instance_profile        = data.aws_iam_instance_profile.instance.name
  user_data                   = local.user_data
  user_data_replace_on_change = true
  credit_specification {
    cpu_credits = "standard"
  }
  metadata_options {
    http_endpoint               = "enabled"
    http_tokens                 = "required"
    http_put_response_hop_limit = 1
  }
  root_block_device {
    volume_type           = "gp3"
    volume_size           = 8
    encrypted             = true
    delete_on_termination = true
  }
  tags        = { Name = "honeyprinter" }
  volume_tags = { Project = "honeyprinter" }
  depends_on = [
    aws_route_table_association.public,
  ]
}

output "instance_id" {
  value = aws_instance.honeypot.id
}

output "public_ip" {
  value = aws_instance.honeypot.public_ip
}
