import * as k8s from '@pulumi/kubernetes'
import * as pulumi from '@pulumi/pulumi'
import * as certmanager from '@vizv/module-cert-manager'
import { AwsFlavouredCredentials } from '@vizv/provider-aws-flavoured-credentials'
import { heredoc } from '@vizv/pulumi-utilities'

export interface MinioArgs {
  namespaceName: pulumi.Input<string>
  baseDomain: pulumi.Input<string>
  dashboardDomain: pulumi.Input<string>
}

export class Minio extends pulumi.ComponentResource {
  public readonly configMap: k8s.core.v1.ConfigMap
  public readonly credentials: AwsFlavouredCredentials
  public readonly secret: k8s.core.v1.Secret
  public readonly statefulSet: k8s.apps.v1.StatefulSet
  public readonly service: k8s.core.v1.Service
  public readonly certificate: certmanager.v1.Certificate
  public readonly ingress: k8s.networking.v1.Ingress

  constructor(
    name: string,
    args: MinioArgs,
    opts?: pulumi.ComponentResourceOptions,
  ) {
    super('vizv:module:Minio', name, {}, opts)

    this.configMap = new k8s.core.v1.ConfigMap(
      name,
      {
        metadata: {
          name,
          namespace: args.namespaceName,
        },
        data: {
          MINIO_DOMAIN: args.baseDomain,
          MINIO_HTTP_TRACE: '/dev/stdout',
        },
      },
      {
        parent: this,
        protect: opts?.protect,
      },
    )

    this.credentials = new AwsFlavouredCredentials(
      name,
      {},
      {
        parent: this,
        protect: opts?.protect,
      },
    )

    this.secret = new k8s.core.v1.Secret(
      name,
      {
        metadata: {
          name,
          namespace: args.namespaceName,
        },
        stringData: {
          MINIO_ROOT_USER: this.credentials.accessKeyId,
          MINIO_ROOT_PASSWORD: this.credentials.secretAccessKey,
        },
      },
      {
        parent: this,
        protect: opts?.protect,
      },
    )

    this.statefulSet = new k8s.apps.v1.StatefulSet(
      name,
      {
        metadata: {
          name,
          namespace: args.namespaceName,
        },
        spec: {
          podManagementPolicy: 'Parallel',
          serviceName: name,
          selector: {
            matchLabels: {
              app: name,
            },
          },
          template: {
            metadata: {
              labels: {
                app: name,
              },
            },
            spec: {
              containers: [
                {
                  name,
                  image: 'minio/minio:latest',
                  env: [
                    {
                      name: 'POD_IP',
                      valueFrom: {
                        fieldRef: {
                          fieldPath: 'status.podIP',
                        },
                      },
                    },
                  ],
                  envFrom: [
                    {
                      configMapRef: {
                        name: this.configMap.metadata.name,
                      },
                    },
                    {
                      secretRef: {
                        name: this.secret.metadata.name,
                      },
                    },
                  ],
                  ports: [
                    {
                      name: 'http',
                      containerPort: 80,
                    },
                    {
                      name: 'console',
                      containerPort: 9001,
                    },
                  ],
                  volumeMounts: [
                    {
                      name,
                      mountPath: '/data',
                      subPath: 'data',
                    },
                  ],
                  command: ['sh', '-exc'],
                  args: [
                    heredoc`
                      echo "$POD_IP\t${args.baseDomain}" >> /etc/hosts
                      exec minio server /data --address '${args.baseDomain}:80' --console-address :9001
                    `,
                  ],
                },
              ],
            },
          },
          volumeClaimTemplates: [
            {
              metadata: {
                name,
              },
              spec: {
                accessModes: ['ReadWriteOnce'],
                resources: {
                  requests: {
                    storage: '1G',
                  },
                },
              },
            },
          ],
        },
      },
      {
        parent: this,
        protect: opts?.protect,
        dependsOn: [this.configMap, this.secret],
      },
    )

    this.service = new k8s.core.v1.Service(
      name,
      {
        metadata: {
          name,
          namespace: args.namespaceName,
        },
        spec: {
          selector: {
            app: name,
          },
          ports: [
            {
              name: 'http',
              port: 80,
            },
            {
              name: 'console',
              port: 9001,
            },
          ],
        },
      },
      {
        parent: this,
        protect: opts?.protect,
      },
    )

    const domainMap = pulumi.all([args.baseDomain, args.dashboardDomain]).apply(
      ([baseDomain, dashboardDomain]) =>
        new Map<string, number>([
          [baseDomain, 80],
          [`*.${baseDomain}`, 80],
          [dashboardDomain, 9001],
        ]),
    )
    const domains = domainMap.apply((map) => Array.from(map.keys()))
    const dnsNames = domains.apply((allDomains) =>
      allDomains.filter(
        (domain) =>
          domain.startsWith('*.') ||
          allDomains.indexOf(`*.${domain.split('.').slice(1).join('.')}`) ===
            -1,
      ),
    )

    this.certificate = new certmanager.v1.Certificate(
      name,
      {
        metadata: {
          name,
          namespace: args.namespaceName,
        },
        spec: {
          secretName: pulumi.interpolate`${name}-tls`,
          issuerRef: {
            kind: 'ClusterIssuer',
            name: 'acme-letsencrypt',
          },
          dnsNames,
        },
      },
      {
        parent: this,
        protect: opts?.protect,
      },
    )

    this.ingress = new k8s.networking.v1.Ingress(
      name,
      {
        metadata: {
          name,
          namespace: args.namespaceName,
        },
        spec: {
          tls: [
            {
              secretName: this.certificate.spec.secretName,
              hosts: domains,
            },
          ],
          rules: domainMap.apply((map) =>
            Array.from(map.entries()).map(([host, number]) => ({
              host,
              http: {
                paths: [
                  {
                    path: '/',
                    pathType: 'Prefix',
                    backend: {
                      service: {
                        name: this.service.metadata.name,
                        port: {
                          number,
                        },
                      },
                    },
                  },
                ],
              },
            })),
          ),
        },
      },
      {
        parent: this,
        protect: opts?.protect,
        dependsOn: [this.service, this.certificate],
      },
    )
  }
}
