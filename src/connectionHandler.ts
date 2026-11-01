import { Logger } from 'homebridge';
import { SerialPort } from 'serialport';
import { Socket } from 'net';
import { EventEmitter } from 'events';

export interface ConnectionConfig {
  connectionType: 'serial' | 'tcp';
  serialPath?: string;
  baudRate?: number;
  host?: string;
  port?: number;
  loginRequired?: boolean;
  username?: string;
  password?: string;
}

// Delay between low-priority (discovery) commands so HomeKit commands never wait behind a long scan.
const QUEUE_INTERVAL_MS = 5;
// Some processors never print "login successful"; stop waiting for it after this long.
const LOGIN_TIMEOUT_MS = 2000;
const RECONNECT_DELAYS_MS = [1000, 2000, 5000, 10000, 30000];

export class ConnectionHandler extends EventEmitter {
  private connection: SerialPort | Socket | null = null;
  private readonly log: Logger;
  private readonly config: ConnectionConfig;
  private buffer = '';
  private loginPending = false;
  private loginSent = false;
  private loginFailed = false;

  private queue: string[] = [];
  private queueTimer: NodeJS.Timeout | null = null;

  private connecting = false;
  private reconnectTimer: NodeJS.Timeout | null = null;
  private reconnectAttempt = 0;
  private closed = false;

  constructor(config: ConnectionConfig, log: Logger) {
    super();
    this.config = config;
    this.log = log;
  }

  async connect(): Promise<void> {
    this.connecting = true;
    try {
      if (this.config.connectionType === 'serial') {
        await this.connectSerial();
      } else {
        await this.connectTCP();
      }
      await this.waitForLogin();
      this.reconnectAttempt = 0;
    } catch (err) {
      this.resetConnection();
      this.scheduleReconnect();
      throw err;
    } finally {
      this.connecting = false;
    }
  }

  private async connectSerial(): Promise<void> {
    return new Promise((resolve, reject) => {
      this.log.info(`Connecting to serial port: ${this.config.serialPath}`);

      const port = new SerialPort({
        path: this.config.serialPath!,
        baudRate: this.config.baudRate || 115200,
      });

      port.on('open', () => {
        this.log.info('Serial port opened successfully');
        this.connection = port;
        if (this.config.loginRequired && !this.loginSent) {
          this.sendImmediateLogin();
        }
        resolve();
      });

      port.on('error', (err) => {
        this.log.error('Serial port error:', err.message);
        reject(err);
      });

      port.on('data', (data) => {
        this.handleData(data.toString());
      });

      port.on('close', () => {
        this.log.warn('Serial port closed');
        this.handleDisconnect(port);
      });
    });
  }

  private async connectTCP(): Promise<void> {
    return new Promise((resolve, reject) => {
      this.log.info(`Connecting to ${this.config.host}:${this.config.port}`);

      const socket = new Socket();

      socket.connect(this.config.port!, this.config.host!, () => {
        this.log.info('TCP connection established');
        // Send each command as soon as it is written instead of batching small packets.
        socket.setNoDelay(true);
        socket.setKeepAlive(true, 30000);
        this.connection = socket;
        if (this.config.loginRequired && !this.loginSent) {
          this.sendImmediateLogin();
        }
        resolve();
      });

      socket.on('error', (err) => {
        this.log.error('TCP connection error:', err.message);
        reject(err);
      });

      socket.on('data', (data) => {
        this.handleData(data.toString());
      });

      socket.on('close', () => {
        this.log.warn('TCP connection closed');
        this.handleDisconnect(socket);
      });
    });
  }

  private waitForLogin(): Promise<void> {
    if (!this.loginPending) {
      return Promise.resolve();
    }
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.removeListener('ready', onReady);
        if (!this.connection) {
          reject(new Error('Connection lost during login'));
        } else if (this.loginFailed) {
          reject(new Error('Login incorrect'));
        } else {
          this.log.debug('No login confirmation received; continuing anyway.');
          this.loginPending = false;
          resolve();
        }
      }, LOGIN_TIMEOUT_MS);
      const onReady = () => {
        clearTimeout(timer);
        resolve();
      };
      this.once('ready', onReady);
    });
  }

  private handleDisconnect(source: SerialPort | Socket): void {
    // Ignore stale events from a connection we've already replaced.
    if (this.connection !== null && this.connection !== source) {
      return;
    }
    const wasConnected = this.connection !== null;
    this.resetConnection();
    if (wasConnected) {
      this.emit('close');
    }
    if (!this.connecting && !this.closed) {
      this.scheduleReconnect();
    }
  }

  private resetConnection(): void {
    this.connection = null;
    this.buffer = '';
    this.loginSent = false;
    this.loginPending = false;
    this.loginFailed = false;
    this.queue = [];
    if (this.queueTimer) {
      clearInterval(this.queueTimer);
      this.queueTimer = null;
    }
  }

  private scheduleReconnect(): void {
    if (this.reconnectTimer || this.closed) {
      return;
    }
    const delay = RECONNECT_DELAYS_MS[Math.min(this.reconnectAttempt, RECONNECT_DELAYS_MS.length - 1)];
    this.reconnectAttempt++;
    this.log.info(`Reconnecting in ${delay / 1000}s...`);
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.connect().then(() => {
        this.log.info('Reconnected to Lutron Homeworks');
        this.emit('reconnected');
      }).catch((err) => {
        this.log.error('Reconnect failed:', err instanceof Error ? err.message : err);
      });
    }, delay);
  }

  private sendImmediateLogin(): void {
    const username = this.config.username || 'lutron';
    const password = this.config.password || 'integration';
    const loginString = `${username}, ${password}\r`;
    this.writeRaw(loginString);
    this.loginSent = true;
    this.loginPending = true;
    this.log.debug('Sent immediate login string:', loginString.trim());
  }

  private handleData(data: string): void {
    this.buffer += data;

    const lines = this.buffer.split('\n');
    this.buffer = lines.pop() || '';

    lines.forEach(line => {
      const trimmed = line.trim();
      if (trimmed) {
        // --- ADDED CHECK HERE ---
        // Ignore the Lutron prompts from the logs
        if (trimmed === 'LNET>' || trimmed === 'Lutron HomeWorks >') {
          return;
        }
        // --- END ADDED CHECK ---

        if (trimmed.toLowerCase().includes('login successful')) {
          this.log.info('Login successful');
          this.loginPending = false;
          this.emit('ready');
        } else if (trimmed.toLowerCase().includes('login incorrect')) {
          this.log.error('Login failed - check username and password');
          this.loginFailed = true;
          this.emit('error', new Error('Login incorrect'));
        } else if (!this.loginPending) {
          this.emit('data', trimmed);
        }
      }
    });
  }

  private writeRaw(data: string): void {
    if (!this.connection) {
      this.log.error('Cannot write - not connected');
      return;
    }
    if (this.config.connectionType === 'serial') {
      (this.connection as SerialPort).write(data);
    } else {
      (this.connection as Socket).write(data);
    }
  }


  write(data: string): void {
    this.writeRaw(data + '\r\n');
  }

  // Queue a low-priority command (e.g. discovery). Sent one at a time so write() commands go out first.
  enqueue(data: string): void {
    if (!this.connection) {
      return;
    }
    this.queue.push(data);
    if (!this.queueTimer) {
      this.queueTimer = setInterval(() => {
        const next = this.queue.shift();
        if (next === undefined) {
          clearInterval(this.queueTimer!);
          this.queueTimer = null;
          return;
        }
        this.write(next);
      }, QUEUE_INTERVAL_MS);
    }
  }

  close(): void {
    this.closed = true;
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    if (this.connection) {
      const connection = this.connection;
      this.resetConnection();
      if (this.config.connectionType === 'serial') {
        (connection as SerialPort).close();
      } else {
        (connection as Socket).end();
      }
    }
  }

  isConnected(): boolean {
    if (!this.connection) {
      return false;
    }

    if (this.config.connectionType === 'serial') {
      return (this.connection as SerialPort).isOpen;
    } else {
      return !(this.connection as Socket).destroyed;
    }
  }
}
