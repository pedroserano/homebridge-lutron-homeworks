import { API, DynamicPlatformPlugin, Logger, PlatformAccessory, PlatformConfig, Service, Characteristic } from 'homebridge';

import { PLATFORM_NAME, PLUGIN_NAME } from './settings';
import { LutronHomeworksPlatformAccessory } from './platformAccessory';
import { ConnectionHandler, ConnectionConfig } from './connectionHandler';

export class LutronHomeworksPlatform implements DynamicPlatformPlugin {
  public readonly Service: typeof Service = this.api.hap.Service;
  public readonly Characteristic: typeof Characteristic = this.api.hap.Characteristic;

  public readonly accessories: PlatformAccessory[] = [];

  private connection: ConnectionHandler;
  private deviceHandlers = {};
  private devices = {};
  private ignoreDevices: string[] = [];
  private defaultFadeTime = 1;
  private discoveryStarted = false;

  constructor(
    public readonly log: Logger,
    public readonly config: PlatformConfig,
    public readonly api: API,
  ) {
    this.log.debug('Finished initializing platform:', this.config.name);

    if ('devices' in this.config) {
      if (Array.isArray(this.config.devices)) {
        for (let i = 0; i < this.config.devices.length; i++) {
          if (typeof this.config.devices === 'object') {
            const x = this.config.devices[i];
            if ('address' in x) {
              this.devices[x.address] = {};
              if ('name' in x) {
                this.devices[x.address]['name'] = x['name'];
                this.log.debug('Found name ' + x['name'] + ' in customDevice ' + x.address);
              }
              if ('fadeTime' in x) {
                this.devices[x.address]['fadeTime'] = x['fadeTime'];
                this.log.debug('Found fadeTime ' + x['fadeTime'] + ' in customDevice ' + x.address);
              }
            } else {
              this.log.warn('customDevice at index ' + i + ' does not contain an address. Values: ' + this.config.devices[i]);
            }
          } else {
            this.log.warn('customDevice at index ' + i + ' is not an object. Values: ' + this.config.devices[i]);
          }
        }
      } else {
        log.warn('Error processing devices from config. Make sure devices is of type Array.');
      }
    }

    if ('ignoreDevices' in this.config) {
      if (Array.isArray(this.config.ignoreDevices)) {
        this.ignoreDevices = this.config.ignoreDevices;
      } else {
        log.warn('Error processing ignoreDevices from config. Make sure ignoreDevices is of type Array.');
      }
    } else {
      this.ignoreDevices = [];
    }

    if ('defaultFadeTime' in this.config) {
      if (typeof this.config.defaultFadeTime === 'number') {
        this.defaultFadeTime = this.config.defaultFadeTime;
      } else {
        log.warn('Error processing defaultFadeTime from config. Make sure defaultFadeTime is of type number.');
      }
    }

    const connectionConfig: ConnectionConfig = {
      // Explicit setting wins. If it's missing, infer TCP when a host is given and no serial path is set.
      connectionType: this.config.connectionType === 'tcp' ? 'tcp'
        : this.config.connectionType === 'serial' ? 'serial'
          : (this.config.host !== undefined && this.config.serialPath === undefined ? 'tcp' : 'serial'),
      serialPath: this.config.serialPath !== undefined ? String(this.config.serialPath) : undefined,
      baudRate: this.config.baudRate !== undefined ? Number(this.config.baudRate) : 115200,
      host: this.config.host !== undefined ? String(this.config.host) : undefined,
      port: this.config.port !== undefined ? Number(this.config.port) : 23,
      loginRequired: this.config.loginRequired !== undefined ? Boolean(this.config.loginRequired) : false,
      username: this.config.username !== undefined ? String(this.config.username) : 'lutron',
      password: this.config.password !== undefined ? String(this.config.password) : 'integration',
    };

    // Validate before connecting so a bad config gives a clear message instead of crashing the bridge.
    if (connectionConfig.connectionType === 'tcp' && !connectionConfig.host) {
      this.log.error('connectionType is "tcp" but no "host" is set in config.json. Set "host" to your Homeworks processor IP address.');
    } else if (connectionConfig.connectionType === 'serial' && !connectionConfig.serialPath) {
      this.log.error(
        'No "serialPath" is set, so serial mode cannot start. '
        + 'For ethernet, set "connectionType": "tcp" and "host": "<processor IP>". '
        + 'For RS-232, set "serialPath" (e.g. /dev/ttyUSB0).',
      );
    }

    this.connection = new ConnectionHandler(connectionConfig, this.log);

    // Only connect; don't send any write/discovery commands here!
    const configValid = connectionConfig.connectionType === 'tcp' ? !!connectionConfig.host : !!connectionConfig.serialPath;
    (configValid ? this.connection.connect() : Promise.reject(new Error('Invalid connection settings; see error above.'))).then(() => {
      // connect() resolves once login has finished, so discovery replies aren't dropped.
      this.log.info('Connected to Lutron Homeworks');
      this.startDiscovery();
    }).catch((err) => {
      // Log and stay alive; throwing here would crash the whole child bridge. The handler keeps retrying.
      this.log.error('Failed to connect:', err instanceof Error ? err.message : err);
    });

    // Handle incoming data lines from processor
    this.connection.on('data', (line: string) => {
      this.handleResponse(line);
    });

    this.connection.on('close', () => {
      this.log.warn('Connection closed, attempting to reconnect...');
    });

    this.connection.on('reconnected', () => {
      if (this.discoveryStarted) {
        this.refreshDevices();
      } else {
        this.startDiscovery();
      }
    });

    // Without a listener, an emitted 'error' (e.g. a wrong password) would crash the bridge.
    this.connection.on('error', (err: Error) => {
      this.log.error('Connection error:', err.message);
    });

    // Remove any .write() or .discoverDevices() calls from didFinishLaunching
    this.api.on('didFinishLaunching', () => {
      log.debug('Executed didFinishLaunching callback');
      // NO device discovery or writes here!
      this.restoreCachedAccessories();
    });
  }

  // Attach handlers to every cached accessory so it stays usable in HomeKit even if discovery never hears from it.
  restoreCachedAccessories() {
    for (const accessory of [...this.accessories]) {
      const device = accessory.context.address;
      if (typeof device !== 'string') {
        this.log.warn('Cached accessory %s has no address. Skipping.', accessory.displayName);
        continue;
      }
      if (device in this.deviceHandlers) {
        this.log.debug('Cached accessory %s already handled by discovery.', device);
        continue;
      }

      if (this.ignoreDevices.includes(device)) {
        this.log.info('Found cached device %s but is marked as an ignored device. Removing from system.', accessory.context.name);
        this.api.unregisterPlatformAccessories(PLUGIN_NAME, PLATFORM_NAME, [accessory]);
        this.accessories.splice(this.accessories.indexOf(accessory), 1);
        continue;
      }

      this.log.debug('Restoring cached accessory %s before discovery.', device);
      this.setContext(accessory, device);
      accessory.displayName = accessory.context.name;
      this.deviceHandlers[device] = new LutronHomeworksPlatformAccessory(this, accessory);
    }
  }

  configureAccessory(accessory: PlatformAccessory) {
    this.log.debug('Loading accessory from cache:', accessory.context.name);
    this.accessories.push(accessory);
  }

  discoverDevices() {
    this.log.info('Starting device discovery');
    this.discoveryStarted = true;
    this.connection.write('');
    this.connection.write('DLMON');

    // Ask about configured and cached devices first so known lights get their state right away.
    const known = new Set<string>(Object.keys(this.devices));
    for (const accessory of this.accessories) {
      if (typeof accessory.context.address === 'string') {
        known.add(accessory.context.address);
      }
    }
    for (const address of known) {
      this.connection.enqueue('RDL, [' + address + ']');
    }

    // Then scan the rest of the address space. Queued commands go out one at a time, so HomeKit commands stay fast.
    let a, b, c, d, e;
    for (a = 1; a <= 16; a++) {
      for (b = 4; b <= 6; b++) {
        for (c = 1; c <= 4; c++) {
          for (d = 1; d <= 12; d++) {
            for (e = 1; e <= 4; e++) {
              const address = '['
                + a.toString().padStart(2, '0') + ':'
                + b.toString().padStart(2, '0') + ':'
                + c.toString().padStart(2, '0') + ':'
                + d.toString().padStart(2, '0') + ':'
                + e.toString().padStart(2, '0') + ']';
              this.connection.enqueue('RDL, ' + address);
            }
          }
        }
      }
    }
    this.log.info('Queued device discovery');
  }

  // After a reconnect, re-enable monitoring and refresh only the devices we already know about.
  refreshDevices() {
    this.log.info('Refreshing %d known devices', Object.keys(this.deviceHandlers).length);
    this.connection.write('DLMON');
    for (const address of Object.keys(this.deviceHandlers)) {
      this.connection.enqueue('RDL, [' + address + ']');
    }
  }

  addDevice(device: string, brightness: number) {
    this.log.debug('Starting initialization for device', device);

    const uuid = this.api.hap.uuid.generate(device);
    const existingAccessory = this.accessories.find(accessory => accessory.UUID === uuid);

    if (existingAccessory) {
      if (this.ignoreDevices.includes(device)) {
        this.log.info('Found existing device %s but is marked as an ignored device. Removing from system.', existingAccessory.context.name);
        this.api.unregisterPlatformAccessories(PLUGIN_NAME, PLATFORM_NAME, [existingAccessory]);
      } else {
        this.log.debug('Existing device %s not found in ignoreDevices. Adding to system.', existingAccessory.context.name);
        this.log.debug('Restoring existing accessory from cache: %s', existingAccessory.context.name);

        this.setContext(existingAccessory, device);
        existingAccessory.displayName = existingAccessory.context.name;

        const accessoryHandler = new LutronHomeworksPlatformAccessory(this, existingAccessory);
        accessoryHandler.updateState(brightness);

        this.deviceHandlers[device] = accessoryHandler;
      }
    } else {
      if (this.ignoreDevices.includes(device)) {
        this.log.info('Found device ' + device + ' but is marked as an ignored device. Ignoring.');
      } else {
        this.log.debug('Existing device ' + device + ' not found in ignoreDevices. Adding to system.');
        this.log.info('Adding new accessory:', device);

        // create a new accessory
        const configuredName = this.devices[device] && 'name' in this.devices[device] ? String(this.devices[device]['name']) : device;
        const accessory = new this.api.platformAccessory(configuredName, uuid);
        this.setContext(accessory, device);

        const accessoryHandler = new LutronHomeworksPlatformAccessory(this, accessory);
        this.api.registerPlatformAccessories(PLUGIN_NAME, PLATFORM_NAME, [accessory]);

        accessoryHandler.updateState(brightness);

        this.deviceHandlers[device] = accessoryHandler;
      }
    }
  }

  updateDevice(address: string, brightness: number) {
    const accessoryHandler = this.deviceHandlers[address];
    accessoryHandler.updateState(brightness);
  }

  processLine(line: string) {
    if (line.includes('DL, ')) {
      this.log.debug('Received line:', line);
      const sections = line.split(',');
      const address = sections[1].substring(2, sections[1].length - 1);
      const brightness = parseInt(sections[2]);
      this.log.debug(address + ',', brightness + '%');

      if (address in this.deviceHandlers) {
        this.log.debug(address, ': Existing device. Updating characteristics.');
        this.updateDevice(address, brightness);
      } else {
        this.log.debug(address, ': New device. Adding to homebridge.');
        this.addDevice(address, brightness);
      }
    }
  }

  setState(device: string, brightness: number, fadeTime: number) {
    this.connection.write('FADEDIM, ' + brightness + ', ' + fadeTime + ', 0, [' + device + ']');
  }

  setContext(accessory: PlatformAccessory, device: string) {
    accessory.context.address = device;

    if (device in this.devices) {
      if ('name' in this.devices[device]) {
        if (this.devices[device]['name'] !== accessory.context.name) {
          this.log.info('Changing device %s name from %s -> %s', device, accessory.context.name, this.devices[device]['name']);
          accessory.context.name = this.devices[device]['name'];
        } else {
          this.log.debug('Device %s name in context matches name in config. No action taken.');
        }
      } else {
        this.log.debug('Setting name not set for device ' + device + '. Setting default name.');
        accessory.context.name = device;
      }

      if ('fadeTime' in this.devices[device]) {
        if (this.devices[device]['fadeTime'] !== accessory.context.fadeTime) {
          this.log.info('Changing device %s fade time from %s -> %s',
            device, accessory.context.fadeTime, this.devices[device]['fadeTime']);
          accessory.context.fadeTime = this.devices[device]['fadeTime'];
        } else {
          this.log.debug('Device %s fadeTime in context matches name in config. No action taken.');
        }
      } else {
        this.log.debug('Setting fadeTime not set for device ' + device + '. Setting default fadeTime.');
        accessory.context.fadeTime = this.defaultFadeTime;
      }
    } else {
      this.log.debug('Device ' + device + ' not found in devices. Setting default name and fadeTime.');
      accessory.context.name = device;
      accessory.context.fadeTime = this.defaultFadeTime;
    }

    this.api.updatePlatformAccessories([accessory]);
  }

  startDiscovery(): void {
    this.log.info('startDiscovery called - implement me!');
    // You can call discoverDevices or implement network logic here
    this.discoverDevices();
  }

  handleResponse(line: string): void {
    this.log.debug('handleResponse called with:', line);
    // For now, just process the line
    this.processLine(line);
  }
}
