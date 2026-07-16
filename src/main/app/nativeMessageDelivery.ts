export interface RecoverableWindowMessaging {
  sendToMain(channel: string, payload: unknown): boolean
  sendToWidget(channel: string, payload: unknown): boolean
  createMainWindow(): Promise<unknown>
  createWidgetWindow(): Promise<unknown>
  showWidget(): Promise<void>
  hideWidget(): void | Promise<void>
}

export class NativeMessageDelivery {
  private pendingWidget: {
    channel: string
    payload: unknown
    reveal: boolean
    resolves: Array<(result: boolean) => void>
  } | null = null
  private widgetDrain: Promise<void> | null = null

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
    return new Promise((resolve) => {
      if (this.pendingWidget === null) {
        this.pendingWidget = { channel, payload, reveal, resolves: [resolve] }
      } else {
        this.pendingWidget.channel = channel
        this.pendingWidget.payload = payload
        this.pendingWidget.reveal = reveal
        this.pendingWidget.resolves.push(resolve)
      }
      if (this.widgetDrain === null) {
        this.startWidgetDrain()
      }
    })
  }

  private startWidgetDrain(): void {
    const drain = this.drainWidget()
    this.widgetDrain = drain
    void drain.finally(() => {
      if (this.widgetDrain !== drain) return
      this.widgetDrain = null
      if (this.pendingWidget !== null) this.startWidgetDrain()
    })
  }

  private async drainWidget(): Promise<void> {
    while (this.pendingWidget !== null) {
      const publication = this.pendingWidget
      this.pendingWidget = null
      const result = await this.deliverWidget(publication)
      for (const resolve of publication.resolves) resolve(result)
    }
  }

  private async deliverWidget(publication: {
    channel: string
    payload: unknown
    reveal: boolean
    resolves: Array<(result: boolean) => void>
  }): Promise<boolean> {
    const { channel, payload, reveal } = publication
    const delivered = this.trySend(() => this.windows.sendToWidget(channel, payload))
    if (delivered) {
      return reveal ? this.revealWidget() : this.concealWidget()
    }

    try {
      await this.windows.createWidgetWindow()
    } catch {
      return false
    }
    if (this.pendingWidget !== null) {
      this.pendingWidget.resolves.unshift(...publication.resolves)
      publication.resolves.length = 0
      return true
    }
    if (!this.trySend(() => this.windows.sendToWidget(channel, payload))) {
      return false
    }
    return reveal ? this.revealWidget() : this.concealWidget()
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

  private async concealWidget(): Promise<boolean> {
    try {
      await this.windows.hideWidget()
      return true
    } catch {
      return false
    }
  }
}
