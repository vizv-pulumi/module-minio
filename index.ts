import * as pulumi from '@pulumi/pulumi'
import { Minio } from './lib'

const config = new pulumi.Config()

const minio = new Minio('minio', {
  namespaceName: config.get('namespaceName') || 'default',
  baseDomain: config.require('baseDomain'),
  dashboardDomain: config.require('dashboardDomain'),
})

export const accessKeyId = minio.credentials.accessKeyId
export const secretAccessKey = minio.credentials.secretAccessKey
