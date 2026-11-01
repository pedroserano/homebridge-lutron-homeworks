import { Service, PlatformAccessory, CharacteristicValue, CharacteristicSetCallback, CharacteristicGetCallback } from 'homebridge';

import { LutronHomeworksPlatform } from './platform';

const SEND_DELAY_MS = 20;

export class LutronHomeworksPlatformAccessory {
  private service: Service;
  private sendTimer: NodeJS.Timeout | null = null;
  private address: string;
  private fadeTime: number;
  private name: string;

  private states = {
    On: false,
    Brightness: 100,
  };

  constructor(
    private readonly platform: LutronHomeworksPlatform,
    private readonly accessory: PlatformAccessory,
  ) {

    this.address = accessory.context.address;
    this.name = accessory.context.name;
    this.fadeTime = accessory.context.fadeTime;

    this.accessory.getService(this.platform.Service.AccessoryInformation)!
      .setCharacteristic(this.platform.Characteristic.Name, accessory.context.name)
      .setCharacteristic(this.platform.Characteristic.Manufacturer, 'Lutron')
      .setCharacteristic(this.platform.Characteristic.Model, 'Homeworks Illumination')
      .setCharacteristic(this.platform.Characteristic.SerialNumber, accessory.context.address);

    this.service = this.accessory.getService(this.platform.Service.Lightbulb) || this.accessory.addService(this.platform.Service.Lightbulb);

    this.service.setCharacteristic(this.platform.Characteristic.Name, accessory.context.name);
    
    this.service.getCharacteristic(this.platform.Characteristic.On)
      .on('set', this.setOn.bind(this))                // SET - bind to the `setOn` method below
      .on('get', this.getOn.bind(this));               // GET - bind to the `getOn` method below

    // register handlers for the Brightness Characteristic
    this.service.getCharacteristic(this.platform.Characteristic.Brightness)
      .on('set', this.setBrightness.bind(this))       // SET - bind to the 'setBrightness` method below
      .on('get', this.getBrightness.bind(this));       // SET - bind to the 'setBrightness` method below
  }

  setOn(value: CharacteristicValue, callback: CharacteristicSetCallback) {

    this.states.On = value as boolean;

    this.platform.log.debug('Set Characteristic On ->', value);

    if (this.states.On && this.states.Brightness === 0) {
      this.states.Brightness = 100;
    }
    this.scheduleSend();
    this.service.updateCharacteristic(this.platform.Characteristic.On, value);

    callback(null);
  }

  // HomeKit often sets On and Brightness together; wait a moment so they go out as one FADEDIM.
  private scheduleSend() {
    if (this.sendTimer) {
      return;
    }
    this.sendTimer = setTimeout(() => {
      this.sendTimer = null;
      this.platform.setState(this.address, this.states.On ? this.states.Brightness : 0, this.fadeTime);
    }, SEND_DELAY_MS);
  }

  getOn(callback: CharacteristicGetCallback) {

    const isOn = this.states.On;
    this.platform.log.debug('Get Characteristic On ->', isOn);

    callback(null, isOn);
  }

  setBrightness(value: CharacteristicValue, callback: CharacteristicSetCallback) {

    this.states.Brightness = value as number;

    this.platform.log.debug('Set Characteristic Brightness ->', value);
    this.states.On = this.states.Brightness > 0;
    this.scheduleSend();

    this.service.updateCharacteristic(this.platform.Characteristic.Brightness, value);
    callback(null);
  }

  getBrightness(callback: CharacteristicGetCallback) {

    const brightness = this.states.Brightness;
    this.platform.log.debug('Get Characteristic Brightness ->', brightness);

    callback(null, brightness);
  }

  updateState(brightness: number){
    const isOn = (brightness !== 0) ? true : false;

    this.platform.log.info('%s: %s, %s%', this.name, isOn ? 'On' : 'Off', brightness);

    this.platform.log.debug('Updating On charactereistic asynchronously to', isOn);
    this.service.updateCharacteristic(this.platform.Characteristic.On, isOn );
    this.states.On = isOn as boolean;

    this.platform.log.debug('Updating Brightness charactereistic asynchronously to', brightness);
    this.service.updateCharacteristic(this.platform.Characteristic.Brightness, brightness);
    this.states.Brightness = brightness as number;
  }
}
