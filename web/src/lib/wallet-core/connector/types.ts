import type { Pset, Wollet, WolletDescriptor } from '@lilbonekit/lwk-web'

import type { ConnectionStatus, WalletType } from '../types'

export interface WalletRequest<T> {
  readonly requestId: string | null
  readonly result: Promise<T>
  cancel?(): Promise<void>
}

export interface WalletConnector {
  readonly id: string | null
  connect(): Promise<void>
  disconnect(): Promise<void>
  getDescriptor(variant: WalletType): Promise<WalletRequest<WolletDescriptor>>
  signPset(pset: Pset): Promise<WalletRequest<Pset>>
  isConnected: boolean
  getConnectionStatus(): Promise<ConnectionStatus>
  getVerifiedReceiveAddress?(variant: WalletType, wollet: Wollet): Promise<string>
}
