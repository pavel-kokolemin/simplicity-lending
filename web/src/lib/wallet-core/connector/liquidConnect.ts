import { Pset, WolletDescriptor } from '@lilbonekit/lwk-web'

import type { From } from '@/api/sideswap/rp_api/From'
import type { LoginRequest } from '@/api/sideswap/rp_api/LoginRequest'
import type { Notif } from '@/api/sideswap/rp_api/Notif'
import type { Req } from '@/api/sideswap/rp_api/Req'
import type { Resp } from '@/api/sideswap/rp_api/Resp'
import type { Session } from '@/api/sideswap/rp_api/Session'
import type { SignRequest } from '@/api/sideswap/rp_api/SignRequest'

import type { ConnectionStatus } from '../types'
import { SeedNotConnectedError } from './errors'
import type { WalletConnector, WalletRequest } from './types'

type ReqId = number

type Deferred<T> = {
  promise: Promise<T>
  resolve(value: T): void
  reject(error: unknown): void
}

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void
  let reject!: (error: unknown) => void
  const promise = new Promise<T>((res, rej) => {
    resolve = res
    reject = rej
  })
  return { promise, resolve, reject }
}

export class LiquidConnect implements WalletConnector {
  private _webSocket: WebSocket | null = null
  private _nextReqId = 1

  private _sessionId: string | null = null
  private _walletId: string | null = null
  private _descriptor: string | null = null

  private readonly _sessions = new Map<string, Session>()
  private readonly _loginRequests = new Map<string, LoginRequest>()
  private readonly _signRequests = new Map<string, SignRequest>()

  private readonly _rpcWaiters = new Map<ReqId, Deferred<Resp>>()
  private readonly _loginWaiters = new Map<string, Deferred<Session>>()
  private readonly _signWaiters = new Map<string, Deferred<string>>()

  constructor(
    private readonly endpoint = 'wss://api-testnet.sideswap.io/server-connect',
    private readonly domain = 'example.com',
  ) {}

  get id(): string | null {
    return this._walletId
  }

  get isConnected(): boolean {
    return this._webSocket?.readyState === WebSocket.OPEN
  }

  async connect(): Promise<void> {
    if (this.isConnected) return

    const ws = new WebSocket(this.endpoint)
    this._webSocket = ws

    ws.addEventListener('message', event => this.handleMessage(event.data))
    ws.addEventListener('close', () => this.handleClose())

    await new Promise<void>((resolve, reject) => {
      ws.addEventListener('open', () => resolve(), { once: true })
      ws.addEventListener('error', () => reject(new Error('LiquidConnect websocket failed')), {
        once: true,
      })
    })

    const resp = await this.rpc({ Login: { domain: this.domain } }, 'Login')

    for (const session of resp.sessions) this.addSession(session)
    for (const req of resp.login_requests) this._loginRequests.set(req.request_id, req)
    for (const req of resp.sign_requests) this._signRequests.set(req.request_id, req)

    const session = resp.sessions[0]
    if (session) this.useSession(session)
  }

  async disconnect(): Promise<void> {
    const sessionId = this._sessionId

    if (sessionId && this.isConnected) {
      await this.rpc(
        { ServerAction: { action: { StopSession: { session_id: sessionId } } } },
        'ServerAction',
      ).catch(() => undefined)
    }

    this._webSocket?.close()
    this.handleClose()
  }

  async getDescriptor(/*_variant: WalletType*/): Promise<WalletRequest<WolletDescriptor>> {
    await this.connect()

    if (this._descriptor) {
      return {
        requestId: null,
        result: Promise.resolve(new WolletDescriptor(this._descriptor)),
      }
    }

    const { login_request: loginRequest } = await this.rpc(
      { StartLogin: { client_data: null } },
      'StartLogin',
    )

    this._loginRequests.set(loginRequest.request_id, loginRequest)

    const result = this.waitLogin(loginRequest.request_id).then(session => {
      this.useSession(session)

      if (!session.__descriptor) {
        throw new SeedNotConnectedError()
      }

      return new WolletDescriptor(session.__descriptor)
    })

    return {
      requestId: loginRequest.request_id,
      result,
      cancel: () =>
        this.rpc(
          {
            ServerAction: {
              action: { CancelLoginRequest: { request_id: loginRequest.request_id } },
            },
          },
          'ServerAction',
        ).then(() => undefined),
    }
  }

  async signPset(pset: Pset): Promise<WalletRequest<Pset>> {
    await this.connect()

    if (!this._sessionId) throw new SeedNotConnectedError()

    const { sign_request: signRequest } = await this.rpc(
      {
        StartSign: {
          session_id: this._sessionId,
          pset: pset.toString(),
          client_data: null,
          ttl: 120_000,
        },
      },
      'StartSign',
    )

    this._signRequests.set(signRequest.request_id, signRequest)

    return {
      requestId: signRequest.request_id,
      result: this.waitSign(signRequest.request_id).then(signedPset => new Pset(signedPset)),
      cancel: () =>
        this.rpc(
          {
            ServerAction: {
              action: { CancelSignRequest: { request_id: signRequest.request_id } },
            },
          },
          'ServerAction',
        ).then(() => undefined),
    }
  }

  async getConnectionStatus(): Promise<ConnectionStatus> {
    return (this._sessionId ? 'ready' : 'disconnected') as ConnectionStatus
  }

  private async rpc<K extends 'Login' | 'StartLogin' | 'StartSign' | 'ServerAction'>(
    req: Req,
    kind: K,
  ): Promise<Extract<Resp, Record<K, unknown>>[K]> {
    const ws = this._webSocket
    if (!ws || ws.readyState !== WebSocket.OPEN) throw new SeedNotConnectedError()

    const id = this._nextReqId++
    const waiter = deferred<Resp>()
    this._rpcWaiters.set(id, waiter)

    ws.send(JSON.stringify({ Req: { id, req } }))

    const resp = await waiter.promise
    if (!(kind in resp)) throw new Error(`Unexpected response type: ${JSON.stringify(resp)}`)

    return resp[kind as keyof Resp] as Extract<Resp, Record<K, unknown>>[K]
  }

  private handleMessage(data: unknown): void {
    const msg = JSON.parse(String(data)) as From

    if ('Resp' in msg) {
      this._rpcWaiters.get(msg.Resp.id)?.resolve(msg.Resp.resp)
      this._rpcWaiters.delete(msg.Resp.id)
      return
    }

    if ('Error' in msg) {
      this._rpcWaiters.get(msg.Error.id)?.reject(new Error(msg.Error.err.message))
      this._rpcWaiters.delete(msg.Error.id)
      return
    }

    this.handleNotif(msg.Notif.notif)
  }

  private handleNotif(notif: Notif): void {
    if ('SessionCreated' in notif) {
      this.addSession(notif.SessionCreated.session)
      this.resolveLogin(notif.SessionCreated.session.request_id)
    } else if ('SessionRemoved' in notif) {
      this._sessions.delete(notif.SessionRemoved.session_id)
      if (this._sessionId === notif.SessionRemoved.session_id) this.clearSession()
    } else if ('LoginRequestUpdated' in notif) {
      const req = notif.LoginRequestUpdated.login_request
      this._loginRequests.set(req.request_id, req)
      this.resolveLogin(req.request_id)
    } else if ('SignRequestUpdated' in notif) {
      const req = notif.SignRequestUpdated.sign_request
      this._signRequests.set(req.request_id, req)
      this.resolveSign(req.request_id)
    }
  }

  private addSession(session: Session): void {
    this._sessions.set(session.session_id, session)
  }

  private useSession(session: Session): void {
    this._sessionId = session.session_id
    this._walletId = session.wallet_id
    this._descriptor = session.__descriptor
  }

  private clearSession(): void {
    this._sessionId = null
    this._walletId = null
    this._descriptor = null
  }

  private waitLogin(requestId: string): Promise<Session> {
    const existing = [...this._sessions.values()].find(session => session.request_id === requestId)
    if (existing) return Promise.resolve(existing)

    const waiter = deferred<Session>()
    this._loginWaiters.set(requestId, waiter)
    this.resolveLogin(requestId)
    return waiter.promise
  }

  private resolveLogin(requestId: string): void {
    const waiter = this._loginWaiters.get(requestId)
    if (!waiter) return

    const session = [...this._sessions.values()].find(item => item.request_id === requestId)
    if (session) {
      waiter.resolve(session)
      this._loginWaiters.delete(requestId)
      return
    }

    const status = this._loginRequests.get(requestId)?.status
    if (status === 'Canceled' || status === 'Timeout') {
      waiter.reject(new SeedNotConnectedError())
      this._loginWaiters.delete(requestId)
    }
  }

  private waitSign(requestId: string): Promise<string> {
    const waiter = deferred<string>()
    this._signWaiters.set(requestId, waiter)
    this.resolveSign(requestId)
    return waiter.promise
  }

  private resolveSign(requestId: string): void {
    const waiter = this._signWaiters.get(requestId)
    if (!waiter) return

    const status = this._signRequests.get(requestId)?.status

    if (typeof status === 'object' && 'Succeed' in status) {
      waiter.resolve(status.Succeed.pset)
      this._signWaiters.delete(requestId)
    } else if (typeof status === 'object' && 'Failed' in status) {
      waiter.reject(new Error(status.Failed.reason))
      this._signWaiters.delete(requestId)
    } else if (status === 'Canceled' || status === 'Timeout') {
      waiter.reject(new SeedNotConnectedError())
      this._signWaiters.delete(requestId)
    }
  }

  private handleClose(): void {
    this.clearSession()
    this._webSocket = null

    for (const waiter of this._rpcWaiters.values()) waiter.reject(new SeedNotConnectedError())
    for (const waiter of this._loginWaiters.values()) waiter.reject(new SeedNotConnectedError())
    for (const waiter of this._signWaiters.values()) waiter.reject(new SeedNotConnectedError())

    this._rpcWaiters.clear()
    this._loginWaiters.clear()
    this._signWaiters.clear()
  }
}
