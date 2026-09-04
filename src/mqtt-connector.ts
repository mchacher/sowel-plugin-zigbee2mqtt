/**
 * MQTT Connector — lightweight wrapper around mqtt.js client.
 * Handles connect, subscribe with wildcard routing, publish, and reconnect.
 */

import mqtt, { type MqttClient, type IClientOptions } from "mqtt";

export type MessageHandler = (topic: string, payload: Buffer) => void;
/** Called every time the live connection state changes — both up and down,
 * not just once at startup. Lets the caller keep its own status field in
 * sync with the actual socket instead of freezing a snapshot taken before
 * the connection is even established (see mchacher/sowel-plugin-zigbee2mqtt#19). */
export type StatusHandler = (connected: boolean) => void;

interface Logger {
  info(obj: Record<string, unknown>, msg: string): void;
  warn(obj: Record<string, unknown>, msg: string): void;
  error(obj: Record<string, unknown>, msg: string): void;
}

interface EventBus { emit(event: unknown): void; }

export class MqttConnector {
  private client: MqttClient | null = null;
  private logger: Logger;
  private eventBus: EventBus;
  private integrationId: string;
  private url: string;
  private options: IClientOptions;
  private handlers: Map<string, MessageHandler[]> = new Map();
  private onStatusChange?: StatusHandler;

  constructor(
    url: string,
    options: { username?: string; password?: string; clientId: string },
    eventBus: EventBus,
    logger: Logger,
    integrationId: string,
    onStatusChange?: StatusHandler,
  ) {
    this.url = url;
    this.options = { clientId: options.clientId, username: options.username, password: options.password, clean: true, reconnectPeriod: 5000 };
    this.eventBus = eventBus;
    this.logger = logger;
    this.integrationId = integrationId;
    this.onStatusChange = onStatusChange;
  }

  async connect(): Promise<void> {
    return new Promise((resolve) => {
      let resolved = false;
      const doResolve = () => { if (!resolved) { resolved = true; resolve(); } };

      this.client = mqtt.connect(this.url, this.options);

      this.client.on("connect", () => {
        this.logger.info({ url: this.url }, "MQTT connected");
        this.eventBus.emit({ type: "system.integration.connected", integrationId: this.integrationId });
        // Re-subscribe every registered pattern on every (re)connect — a
        // subscribe() call made while offline (e.g. broker not up yet at
        // boot) never reaches the broker, and mqtt.js does not retry it on
        // its own. Without this, the socket can report "connected" while
        // no topic is actually being listened to.
        this.resubscribeAll();
        this.onStatusChange?.(true);
        doResolve();
      });

      this.client.on("reconnect", () => { this.logger.warn({ url: this.url }, "MQTT reconnecting"); });

      this.client.on("disconnect", () => {
        this.logger.warn({ url: this.url }, "MQTT disconnected");
        this.eventBus.emit({ type: "system.integration.disconnected", integrationId: this.integrationId });
        this.onStatusChange?.(false);
      });

      this.client.on("offline", () => {
        this.logger.warn({ url: this.url }, "MQTT offline");
        this.eventBus.emit({ type: "system.integration.disconnected", integrationId: this.integrationId });
        this.onStatusChange?.(false);
      });

      this.client.on("error", (err) => {
        this.logger.error({ err: err.message } as Record<string, unknown>, "MQTT error");
        doResolve();
      });

      this.client.on("message", (topic, payload) => { this.routeMessage(topic, payload); });

      setTimeout(() => {
        if (!this.isConnected()) {
          this.logger.warn({ url: this.url }, "MQTT initial connection timeout, continuing");
        }
        doResolve();
      }, 10_000);
    });
  }

  subscribe(topicPattern: string, handler: MessageHandler): void {
    if (!this.handlers.has(topicPattern)) this.handlers.set(topicPattern, []);
    this.handlers.get(topicPattern)!.push(handler);
    // Only issue the live subscribe when the socket is actually connected —
    // calling client.subscribe() while offline fails with "Connection
    // closed" and is never retried by mqtt.js itself. If we're not
    // connected yet (or not anymore), resubscribeAll() picks this pattern
    // up the next time the "connect" event genuinely fires.
    if (this.client?.connected) {
      this.client.subscribe(topicPattern, (err) => {
        if (err) this.logger.error({ err, topic: topicPattern } as Record<string, unknown>, "Subscribe error");
      });
    }
  }

  private resubscribeAll(): void {
    if (!this.client) return;
    for (const topicPattern of this.handlers.keys()) {
      this.client.subscribe(topicPattern, (err) => {
        if (err) this.logger.error({ err, topic: topicPattern } as Record<string, unknown>, "Subscribe error");
      });
    }
  }

  publish(topic: string, payload: string | Buffer): void {
    if (!this.client || !this.isConnected()) { this.logger.warn({ topic } as Record<string, unknown>, "Cannot publish: not connected"); return; }
    this.client.publish(topic, payload, (err) => { if (err) this.logger.error({ err, topic } as Record<string, unknown>, "Publish error"); });
  }

  isConnected(): boolean { return this.client?.connected ?? false; }

  async disconnect(): Promise<void> {
    if (this.client) { await this.client.endAsync(); this.logger.info({} as Record<string, unknown>, "MQTT disconnected"); }
  }

  private routeMessage(topic: string, payload: Buffer): void {
    for (const [pattern, handlers] of this.handlers) {
      if (this.topicMatches(pattern, topic)) {
        for (const handler of handlers) {
          try { handler(topic, payload); } catch (err) { this.logger.error({ err, topic } as Record<string, unknown>, "Handler error"); }
        }
      }
    }
  }

  private topicMatches(pattern: string, topic: string): boolean {
    const pp = pattern.split("/");
    const tp = topic.split("/");
    for (let i = 0; i < pp.length; i++) {
      if (pp[i] === "#") return true;
      if (i >= tp.length) return false;
      if (pp[i] !== "+" && pp[i] !== tp[i]) return false;
    }
    return pp.length === tp.length;
  }
}
