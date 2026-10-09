import { readFileSync } from 'node:fs';
import { Stack, CfnOutput, Tags, Validations, aws_ec2 as ec2, aws_iam as iam } from 'aws-cdk-lib';
import type { StackProps } from 'aws-cdk-lib';
import type { Construct } from 'constructs';
import ports from '../shared/ports.json' with { type: 'json' };

export interface Artifact {
  readonly bucket: string;
  readonly key: string;
  readonly sha256: string;
}

export class HoneyprinterStack extends Stack {
  constructor(scope: Construct, id: string, artifact: Artifact, props?: StackProps) {
    super(scope, id, props);
    Tags.of(this).add('Project', 'honeyprinter');
    Tags.of(this).add('Implementation', 'cdk');

    const vpc = new ec2.Vpc(this, 'Vpc', {
      ipAddresses: ec2.IpAddresses.cidr('10.77.0.0/16'),
      availabilityZones: ['us-west-2a'],
      natGateways: 0,
      restrictDefaultSecurityGroup: false,
      subnetConfiguration: [{ name: 'public', subnetType: ec2.SubnetType.PUBLIC, cidrMask: 24 }],
    });
    const securityGroup = new ec2.SecurityGroup(this, 'Decoys', {
      vpc,
      allowAllOutbound: false,
      description: 'Public TCP decoys; port 22 is a fake SSH service',
    });
    for (const port of ports) {
      securityGroup.addIngressRule(ec2.Peer.anyIpv4(), ec2.Port.tcp(port));
    }
    securityGroup.addEgressRule(ec2.Peer.anyIpv4(), ec2.Port.tcp(443),
      'HTTPS for S3, SSM, and future Cloudflare delivery');
    Validations.of(securityGroup).acknowledge({
      id: 'CloudFormation-Validate::W2508',
      reason: 'Intentionally public honeypot ports; every listener is a protocol decoy.',
    });

    const role = new iam.Role(this, 'InstanceRole', {
      assumedBy: new iam.ServicePrincipal('ec2.amazonaws.com'),
      managedPolicies: [iam.ManagedPolicy.fromAwsManagedPolicyName('AmazonSSMManagedInstanceCore')],
      inlinePolicies: {
        Artifact: new iam.PolicyDocument({ statements: [new iam.PolicyStatement({
          actions: ['s3:GetObject'],
          resources: [`arn:aws:s3:::${artifact.bucket}/${artifact.key}`],
        })] }),
      },
    });
    const startup = readFileSync(new URL('../shared/bootstrap.sh', import.meta.url), 'utf8')
      .replaceAll('@ARTIFACT_BUCKET@', artifact.bucket)
      .replaceAll('@ARTIFACT_KEY@', artifact.key)
      .replaceAll('@ARTIFACT_SHA256@', artifact.sha256);
    const instance = new ec2.Instance(this, 'Honeypot', {
      vpc, securityGroup, role,
      vpcSubnets: { subnetType: ec2.SubnetType.PUBLIC },
      instanceName: 'honeyprinter',
      instanceType: new ec2.InstanceType('t3.nano'),
      machineImage: ec2.MachineImage.fromSsmParameter(
        '/aws/service/ami-amazon-linux-latest/al2023-ami-kernel-default-x86_64',
        { os: ec2.OperatingSystemType.LINUX }),
      associatePublicIpAddress: true,
      creditSpecification: ec2.CpuCredits.STANDARD,
      httpEndpoint: true,
      httpTokens: ec2.HttpTokens.REQUIRED,
      httpPutResponseHopLimit: 1,
      blockDevices: [{ deviceName: '/dev/xvda', volume: ec2.BlockDeviceVolume.ebs(8, {
        encrypted: true, volumeType: ec2.EbsDeviceVolumeType.GP3, deleteOnTermination: true,
      }) }],
      userData: ec2.UserData.custom(startup),
      userDataCausesReplacement: true,
    });
    new CfnOutput(this, 'InstanceId', { value: instance.instanceId });
    new CfnOutput(this, 'PublicIp', { value: instance.instancePublicIp });
  }
}
