export interface RecoverableWindowMessaging {
  sendToMain(channel: string, payload: unknown): boolean
  sendToWidget(channel: string, payload: unknown): boolean
  createMainWindow(): Promise<unknown>
  createWidgetWindow(): Promise<unknown>
  showWidget(): Promise<void>
}

export class NativeMessageDelivery {
  constructor(private readonly windows: RecoverableWindowMessaging) {}

  async sendToMain(channel: string, payload: unknown): Promise<boolean> {
    if (this.trySend(() => this.windows.sendToMain(channel, payload))) {
      return true
    }

    try {
      await this.windows.createMainWindow()
    } catch {
      return false
    }
    return this.trySend(() => this.windows.sendToMain(channel, payload))
  }

  async sendToWidget(
    channel: string,
    payload: unknown,
    reveal: boolean,
  ): Promise<boolean> {
    const delivered = this.trySend(() => this.windows.sendToWidget(channel, payload))
    if (delivered) {
      return reveal ? this.revealWidget() : true
    }

    try {
      await this.windows.createWidgetWindow()
    } catch {
      return false
    }
    if (!this.trySend(() => this.windows.sendToWidget(channel, payload))) {
      return false
    }
    return reveal ? this.revealWidget() : true
  }

  private trySend(send: () => boolean): boolean {
    try {
      return send()
    } catch {
      return false
    }
  }

  private async revealWidget(): Promise<boolean> {
    try {
      await this.windows.showWidget()
      return true
    } catch {
      return false
    }
  }
}
