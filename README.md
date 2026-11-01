# homebridge-lutron-homeworks

Lutron Homeworks plug-in for [Homebridge](https://github.com/nfarina/homebridge) using RS232 (and now also ethernet for those with a Homeworks system with an ethernet port on it). This modification allows you to use either RS-232 or TCP/Telnet connections to your Lutron Homeworks system!

Got an old school Lutron Homeworks system? Don't want to pay $10,000+ to retrofit all of your dimmers for HomeKit? Then you're at the right place.

# Requirements

1. Check environment compatiblity for [Node SerialPort](https://serialport.io/docs/guide-platform-support).
2. Connect host system to the Lutron Homeworks board using RS232 or ethernet.
3. Check if you can successfully log into the system prior to installing the plugin (optional but recommended, see below)

# Installation

<!-- 2. Clone (or pull) this repository from github into the same path Homebridge lives (usually `/usr/local/lib/node_modules`). -->
1. Install homebridge using: `npm install -g homebridge`
2. Install this plug-in using: `npm install -g homebridge-lutron-homeworks`
3. Edit the plugin's settings in [homebridge-config-ui-x](https://github.com/oznu/homebridge-config-ui-x) in or update your configuration file manually. See example `config.json` snippet below.

This plugin was tested in docker using oznu's [docker-homebridge](https://github.com/oznu/docker-homebridge) image running on an Ubuntu 20.04 host.

# Configuration

ETHERNET Minimum configuration sample (edit `~/.homebridge/config.json`):

```
"platforms": [
    {
      "name": "Lutron Homeworks",
      "connectionType": "tcp",
      "host": "192.168.1.100",
      "port": 23,
      "loginRequired": true,
      "username": "lutron",
      "password": "jetski",
      "defaultFadeTime": 1,
      "platform": "LutronHomeworksEthernet"
    }
  ]
```

SERIAL Minimum configuration sample (edit `~/.homebridge/config.json`):

```
"platforms": [
    {
      "name": "Lutron Homeworks",
      "connectionType": "serial",
      "serialPath": "/dev/ttyUSB0",
      "baudRate": 115200,
      "loginRequired": true,
      "password": "jetski",
      "platform": "LutronHomeworksEthernet"
    }
  ],
```

Required fields if your Lutron Homeworks system requires authentication:

* `"loginRequired"`: Must be `"true"`
* `"password"`: Lutron Homeworks system password. (Default is `jetski`...don't ask why)

Optional fields:

* `"baudRate"`: `some number` // optionally sets the baud rate of the serial port (defaults to 115200)
* `"defaultFadeTime"`: `some number` // optional fade time in seconds to use for all discovered devices (defaults to 1 if omitted)
* `"devices"`: `[{ "address": "01:04:01:01:01", "name": "Formal Living", "fadeTime": 3 },...]` // optional list of devices with their name and specific fade times. This fade time overwrites defaultFadeTime.
* `"ignoreDevices"`: `["01:04:01:01:02",...]` //optional list of devices to ignore and not add into HomeKit

Sample configuration with optional values (edit `~/.homebridge/config.json`):
```
"platforms": [
        {
            "name": "Lutron Homeworks",
            "serialPath": "/dev/ttyUSB0",
            "loginRequired": true,
            "password": "jetski",
            "defaultFadeTime": 1,
            "devices": [
                {
                    "address": "01:04:01:01:01",
                    "name": "Formal Living"
                },
                {
                    "address": "01:04:01:01:02",
                    "name": "Powder Hallway",
                    "fadeTime": 5
                },
                {
                    "address": "01:04:01:01:04",
                    "name": "Family Room Lights"
                }
            ],
            "ignoreDevices": [
                 "01:04:01:01:05",
                 "01:04:01:01:06"
            ],
            "platform": "LutronHomeworksEthernet"
        }
    ],
```

# Keeping accessories in HomeKit

Homebridge deletes cached accessories (and with them their HomeKit rooms, scenes and automations) when no loaded plugin claims them. To avoid that:

* The `"platform"` value must be exactly `LutronHomeworksEthernet`. Any other value means the plugin never loads and its accessories are orphaned.
* Don't change device address formats or the bridge `username`. Accessories are identified by their address, and HomeKit treats a new bridge `username` as a brand new bridge.
* Start Homebridge with `-K` (keep orphans) so accessories survive if the plugin temporarily fails to load. In homebridge-config-ui-x this is the "keep orphans" option in the Homebridge settings.
* Upgrading from the original `homebridge-lutron-homeworks` package: the plugin and platform names changed, so accessories are re-created once and need to be assigned to rooms again.

Devices that don't respond during discovery are not removed. Cached accessories are restored at startup and update as soon as the processor reports their state. Only devices listed in `ignoreDevices` are removed.

# What the heck are "Addresses"?

Addresses are literally the address for a dimmer or switch. Don't worry if you don't know the addresses of the devices on your Lutron Homework network. This plugin will add all the discovered devices using the address as the device's name in HomeKit. You can then edit `config.json` as needed.

# What does this plugin do?

1. Plugin sends the `LOGIN, <password>` if `loginRequired` is `true`
2. Plugin sends the `DLMON` command to Lutron Homeworks so that we can observe when a dimmer's state has been changed
3. Plugin sends the `RDL, [<address>]` command for every single possible address value. This command will return back a dimmer's current brightness level if a dimmer exists at `address`. This accomplishes two things:
   1. Discovers all the dimmers in the system
   2. Determines their current state
   
# What kind of wizardry is this?

This isn't wizardry. Just taking advantage of Lutron HomeWorks protocol. You can read more about the protocol [here](https://www.lutron.com/TechnicalDocumentLibrary/HWI%20RS232%20Protocol.pdf).

# Testing

1. First test your telnet connection manually:
   
   ```
   telnet 192.168.4.87 23
   ```
1. You should see the `LOGIN:` prompt. Type:
   
   ```
   lutron, jetski
   ```
1. You should see `login successful`. Now try some commands:
   
   ```
   DLMON
   ```
1. Once you confirm telnet works, restart Homebridge and check the logs for successful connection messages.

# Troubleshooting

- **Connection refused**: Check your IP address and port number
- **Timeout**: Verify your Lutron device is accessible on the network
- **Authentication failed**: Double-check your password
- **No response from device**: Some Lutron systems may need a slight delay after connecting before sending commands
- **Connection dropped**: The plugin reconnects automatically, retrying after 1, 2, 5, 10 and then every 30 seconds, and refreshes known devices once it's back

# Making lights respond faster

* Lights fade over `defaultFadeTime` seconds (1 by default). Set `"defaultFadeTime": 0`, or `"fadeTime": 0` on individual devices, to make them switch instantly.
* Listing your devices under `devices` lets the plugin ask about them first at startup, before it scans the rest of the address space. The scan runs in the background and never delays commands from HomeKit.

-----
