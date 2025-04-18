import { App, Stack } from 'aws-cdk-lib';
import { Template } from 'aws-cdk-lib/assertions';
import { OpenWebUIEcsConstruct } from '../src/llm-construct/index';

describe('OpenWebUIEcsConstruct', () => {
    let app: App;
    let template: Template;

    beforeAll(() => {
        app = new App();
        const stack = new Stack(app, 'TestStack');
        new OpenWebUIEcsConstruct(stack, 'OpenWebUIEcsConstruct');
        template = Template.fromStack(stack);
    });

    test('ALB Listener Rule "AllowValidHeader" exists with correct configuration', () => {
        // Check that a ListenerRule is defined with the header condition and priority 1.
        template.hasResourceProperties('AWS::ElasticLoadBalancingV2::ListenerRule', {
            Priority: 1,
            Conditions: [
                {
                    Field: "http-header",
                    HttpHeaderConfig: {
                        HttpHeaderName: "x-unique-header",
                        Values: ["RUDY-LLM-PRIVATE-LINK"]
                    }
                }
            ],
        });
    });

    test('CloudFront Distribution has custom header "x-unique-header"', () => {
        // Check that CloudFront distribution includes an origin with the expected custom header.
        template.hasResourceProperties('AWS::CloudFront::Distribution', {
            DistributionConfig: {
                Origins: [
                    {
                        OriginCustomHeaders: [
                            {
                                HeaderName: 'x-unique-header',
                                HeaderValue: 'RUDY-LLM-PRIVATE-LINK'
                            }
                        ]
                    }
                ]
            }
        });
    });

    test('VPC and ECS Cluster are created', () => {
        // Check that one VPC is created.
        template.resourceCountIs('AWS::EC2::VPC', 1);
        // Check that one ECS Cluster is created.
        template.resourceCountIs('AWS::ECS::Cluster', 1);
    });

    test('EFS FileSystem is created with the correct configuration', () => {
        // Check that a FileSystem is created with PerformanceMode GENERAL_PURPOSE.
        template.hasResourceProperties('AWS::EFS::FileSystem', {
            PerformanceMode: "generalPurpose"
        });
    });

    test('ECS Task Definition has required volumes', () => {
        // Check that the TaskDefinition includes the two volumes: openwebuiVolume and pipelinesVolume.
        template.hasResourceProperties('AWS::ECS::TaskDefinition', {
            Volumes: [
                {
                    Name: 'openwebuiVolume'
                },
                {
                    Name: 'pipelinesVolume'
                }
            ]
        });
    });

    test('CloudFront Distribution output "CloudFrontDomain" is defined', () => {
        // Find all outputs
        const outputs = template.findOutputs('*');

        // Ensure at least one output key contains 'CloudFrontDomain'
        const domainOutputKey = Object.keys(outputs).find(key => key.includes('CloudFrontDomain'));
        expect(domainOutputKey).toBeDefined();

        // Confirm the output uses the expected description
        expect(outputs[domainOutputKey!].Description).toBe('The CloudFront distribution domain name');
    });
});

describe('OpenWebUIEcsStack Additional Tests', () => {
    let app: App;
    let template: Template;

    beforeAll(() => {
        app = new App();
        const stack = new Stack(app, 'AdditionalTestStack');
        new OpenWebUIEcsConstruct(stack, 'OpenWebUIEcsConstruct');
        template = Template.fromStack(stack);
    });

    test('ECS Task Definition container definitions are configured correctly', () => {
        template.hasResourceProperties('AWS::ECS::TaskDefinition', {
            ContainerDefinitions: [
                {
                    Name: 'openwebui',
                    Environment: [
                        { Name: 'DATA_DIR', Value: '/app/backend/data' }
                    ],
                    PortMappings: [
                        { ContainerPort: 8080 }
                    ],
                    MountPoints: [{
                        ContainerPath: '/app/backend/data'
                    }]
                },
                {
                    Name: 'pipelines',
                    MountPoints: [{
                        ContainerPath: '/app/pipelines'
                    }]
                }
            ]
        });
    });

    test('ALB is configured as internet-facing', () => {
        template.hasResourceProperties('AWS::ElasticLoadBalancingV2::LoadBalancer', {
            Scheme: 'internet-facing'
        });
    });

    test('ECS Service has desired count of 1', () => {
        template.hasResourceProperties('AWS::ECS::Service', {
            DesiredCount: 1
        });
    });

    test('HTTP Listener is configured on port 80', () => {
        template.hasResourceProperties('AWS::ElasticLoadBalancingV2::Listener', {
            Port: 80
        });
    });
});
