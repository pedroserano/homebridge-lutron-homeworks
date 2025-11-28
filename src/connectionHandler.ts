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

export class ConnectionHandler extends EventEmitter {
  private connection: SerialPort | Socket | null = null;
  private readonly log: Logger;
  private readonly config: ConnectionConfig;
  private buffer = '';
  private loginPending = false;

  constructor(config: ConnectionConfig, log: Logger) {
    super();
    this.config = config;
    this.log = log;
  }

  async connect(): Promise<void> {
    if (this.config.connectionType === 'serial') {
      return this.connectSerial();
    } else {
      return this.connectTCP();
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
        // Check for immediate login requirement after connection
        if (this.config.loginRequired && !this.loginSent) {
          this.sendImmediateLogin();
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
        this.emit('close');
      });
    });
  }

  private async connectTCP(): Promise<void> {
    return new Promise((resolve, reject) => {
      this.log.info(`Connecting to ${this.config.host}:${this.config.port}`);
      
      const socket = new Socket();
      
      socket.connect(this.config.port!, this.config.host!, () => {
        this.log.info('TCP connection established');
        this.connection = socket;
        // Check for immediate login requirement after connection
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
        this.emit('close');
      });

      socket.on('end', () => {
        this.log.warn('TCP connection ended');
        this.emit('close');
      });
    });
  }

   // Helper function to send the exact required login string
  private sendImmediateLogin(): void {
    const username = this.config.username || 'lutron';
    const password = this.config.password || 'integration';
    // Send the exact required format with a single carriage return
    const loginString = `${username}, ${password}\r`; 
    this.writeRaw(loginString); // Use the new raw write function
    this.loginSent = true;
    this.loginPending = true; // Still pending until 'Login successful' is seen
    this.log.debug('Sent immediate login string:', loginString.trim());
  }
  
  private handleData(data: string): void {
    this.buffer += data;
    
    // Split on newlines and process complete lines
    const lines = this.buffer.split('\n');
    
    // Keep the last incomplete line in the buffer
    this.buffer = lines.pop() || '';
    
    // Emit each complete line
    lines.forEach(line => {
      const trimmed = line.trim();
      if (trimmed) {
        // We no longer wait for a "LOGIN:" prompt if we are using immediate login
        // The original code waited for this prompt, which caused the hang/error
        
        if (trimmed.toLowerCase().includes('login successful')) {
          this.log.info('Login successful');
          this.loginPending = false;
          this.emit('ready');
        } else if (trimmed.toLowerCase().includes('login incorrect')) {
          this.log.error('Login failed - check username and password');
          this.emit('error', new Error('Login incorrect'));
        } else if (!this.loginPending) {
          // Only emit data after login is complete
          this.emit('data', trimmed);
        }
      }
    });
  }

   // A new helper method that writes exactly what is passed to it, no extra ending chars.
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
    if (!this.connection) {
      this.log.error('Cannot write - not connected');
      return;
    }

    // Don't add extra line ending if this is a login response
    const ending = this.loginPending ? '' : '\r\n';
    
    if (this.config.connectionType === 'serial') {
      (this.connection as SerialPort).write(data + ending);
    } else {
      (this.connection as Socket).write(data + ending);
    }
  }

  close(): void {
    if (this.connection) {
      if (this.config.connectionType === 'serial') {
        (this.connection as SerialPort).close();
      } else {
        (this.connection as Socket).end();
      }
      this.connection = null;
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
