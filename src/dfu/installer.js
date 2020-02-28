import DFU from '../dfu/dfu'
import DFUse from '../dfu/dfuse'
import firebase from "../firebase"

import {releases} from '../firmware/firmwares'

const AUTOCONNECT_DELAY = 1000;

// Used for debugging. When true, skips downloading and flashing.
const DO_DRY_RUN = false;

export default class Installer {
    constructor(install) {
        this.installInstance = install;
        this.device = null;
        this.transferSize = 2048;
        this.manifestationTolerant = false;
        this.toInstall = "latest";
        this.firmwareInfos = null;
        this.ignore_disconnect = false;
        this.storage = firebase.storage();
        this.autoconnectId = 0;
        this.storage_content = null;
        this.waiting_for_flash = false;
    }
    
    init(versionToInstall) {
        this.toInstall = versionToInstall;
        if (this.toInstall === "latest") {
            this.toInstall = releases.latest;
        }
        
        
        for (var firm in releases.firmwares) {
            if (releases.firmwares[firm].name === this.toInstall) {
                this.firmwareInfos = releases.firmwares[firm];
                break;
            }
        }
        
        if (this.firmwareInfos == null) {
            this.installInstance.firmwareNotFound(this.toInstall);
            return;
        } else {
            this.installInstance.calculatorError(false, null);
        }
        
        
        if (typeof navigator.usb === 'undefined') {
            this.installInstance.installerNotCompatibleWithThisBrowser();
        } else {
            navigator.usb.addEventListener("disconnect", this.onUnexpectedDisconnect.bind(this));
            this.autoConnect(0x0483, 0xa291);
        }
    }
    
    async __connect(device) {
        try {
            await device.open();
        } catch (error) {
            // this.installInstance.calculatorError(true, error);
            throw error;
        }

        // Attempt to parse the DFU functional descriptor
        let desc = {};
        try {
            desc = await getDFUDescriptorProperties(device);
        } catch (error) {
            // this.installInstance.calculatorError(true, error);
            throw error;
        }

        if (desc && Object.keys(desc).length > 0) {
            device.properties = desc;
            this.transferSize = desc.TransferSize;
            if (desc.CanDnload) {
                this.manifestationTolerant = desc.ManifestationTolerant;
            }

            if ((desc.DFUVersion === 0x100 || desc.DFUVersion === 0x011a) && device.settings.alternate.interfaceProtocol === 0x02) {
                device = new DFUse.Device(device.device_, device.settings);
                if (device.memoryInfo) {
                    // We have to add RAM manually, because... meh.
                    device.memoryInfo.segments.unshift({
                        start: 0x20000000,
                        sectorSize: 1024,
                        end: 0x20040000,
                        readable: true,
                        erasable: false,
                        writable: true
                    });
                
                    /*
                    let totalSize = 0;
                    for (let segment of device.memoryInfo.segments) {
                        totalSize += segment.end - segment.start;
                    }
                    */
                }
            }
        }

        // Bind logging methods
        device.logDebug = console.log;
        device.logInfo = console.info;
        device.logWarning = console.warn;
        device.logError = console.error;
        device.logProgress = console.log;
        
        return device;
    }
    
    __getModel() {
        var n = this.device.memoryInfo.segments[this.device.memoryInfo.segments.length-1].end;
        return n > 0x080E0000 && n < 0x90000000 ? "0100" : "0110";
    }
    
    async __getPlatformInfo() {
        this.device.startAddress = 0x080001c4;
        const blob = await this.device.do_upload(this.transferSize, 0x48);
        return parsePlatformInfo(await blob.arrayBuffer());
    }
    
    async __setCalculatorInfos() {
        this.installInstance.setModel("N" + this.__getModel());
        
        let pinfo = await this.__getPlatformInfo();
        
        // {"magik":true,"oldplatform":false,"omega":{"installed":true,"version":"1.19.0-0","user":""},"version":"13.0.0","commit":"dcaa1cb","storage":{"address":536874844,"size":32768}}
        
        if (pinfo.magik) {
            this.installInstance.setEpsilonVersion(pinfo.version);
            if (pinfo.omega.installed) {
                this.installInstance.setOmegaVersion(pinfo.omega.version);
                
                if (pinfo.omega.user.trim().length > 0) {
                    this.installInstance.setUsername(pinfo.omega.user.trim());
                }
            }
        }
        
        this.installInstance.calculatorDetected(pinfo.omega.installed ? "omega" : "epsilon");
        
    }
    
    async __sha256(blob) {
        const msgUint8 = await blob.arrayBuffer();
        const hashBuffer = await crypto.subtle.digest('SHA-256', msgUint8);
        const hashArray = Array.from(new Uint8Array(hashBuffer));
        const hashHex = hashArray.map(b => b.toString(16).padStart(2, '0')).join('');
        return hashHex;
    }
    
    __downloadFirmware(model, version, fwname, callback) {
        this.storage.ref().child('firmwares/' + version + '/' + model.toLowerCase() + '/' + fwname).getDownloadURL().then(function(url) {
            var oReq = new XMLHttpRequest();
            oReq.responseType = 'blob';

            console.log("[DOWNLOAD] " + url);

            oReq.onload = function(oEvent) {
                var blob = oReq.response;
                callback(blob);
            };
            oReq.open("GET", url, true);
            oReq.send();
        }).catch(function(error) {
            console.log("[DOWNLOAD] " + error.code);
        });
    }
    
    __downloadSHA256(model, version, fwname, callback) {
        this.storage.ref().child('firmwares/' + version + '/' + model.toLowerCase() + '/' + fwname + ".sha256").getDownloadURL().then(function(url) {
            var oReq = new XMLHttpRequest();
            
            console.log("[DOWNLOAD] " + url);

            oReq.onload = function(e) {
                callback(oReq.responseText.split(' ')[0]);
            }

            oReq.open("GET", url, true);
            oReq.send();
        }).catch(function(error) {
            console.log("[DOWNLOAD] " + error.code);
        });
    }
    
    __downloadFirmwareCheck(model, version, firmware, callback) {
        this.__downloadFirmware(model, version, firmware, async blob => {
            this.__downloadSHA256(model, version, firmware, async sha256 => {
                var calcSha256 = await this.__sha256(blob);
                
                console.log(sha256);
                console.log(calcSha256);
                
                if (sha256 === calcSha256) {
                    callback(true, blob);
                } else {
                    callback(false, blob);
                }
            });
            
        });
    }
    
    async __retreiveStorage(address, size) {
        this.device.startAddress = address;
        return await this.device.do_upload(this.transferSize, size + 8);
    }
    
    async __flashStorage(address, data) {
        console.log(data);
        this.device.startAddress = address;
        await this.device.do_download(this.transferSize, data, false);
    }
    
    __readString(dv, index, maxLen) {
        var out = "";
        var i = 0;
        for(i = 0; i < maxLen || maxLen === 0; i++) {
            var chr = dv.getUint8(index + i);
            
            if (chr === 0) {
                break;
            }
            
            out += String.fromCharCode(chr);
        }
        
        return {
            size: i + 1,
            content: out
        };
    }
    
    async __sliceStorage(blob) {
        var dv = new DataView(await blob.arrayBuffer());
        
        if (dv.getUint32(0x00, false) === 0xBADD0BEE) {
            var offset = 4;
            var records = [];
            
            do {
                var size = dv.getUint16(offset, true);
                
                if (size === 0) break;
                
                var name = this.__readString(dv, offset + 2, size - 2);
                
                var data = blob.slice(offset + 2 + name.size, offset + size);
                
                var record = {
                    name: name.content.split(/\.(?=[^\.]+$)/)[0], // eslint-disable-line no-useless-escape
                    type: name.content.split(/\.(?=[^\.]+$)/)[1], // eslint-disable-line no-useless-escape
                    data: data,
                }
                
                records.push(record);
                
                offset += size;
                
            } while (size !== 0 && offset < blob.size);
            
            return records;
        } else {
            return {};
        }
    }
    
    async __parsePyRecord(record) {
        var dv = new DataView(await record.data.arrayBuffer());
        
        record.autoImport = dv.getUint8(0) !== 0;
        record.code = this.__readString(dv, 1, record.data.size - 1).content;
        
        delete record.data;
        
        return record;
    }
    
    __getRecordParsers() {
        return {
            py: this.__parsePyRecord.bind(this)
        };
    }
    
    async __parseRecord(record) {
        var parsers = this.__getRecordParsers();
        
        if (record.type in parsers) {
            record = parsers[record.type](record);
        }
        
        return record;
    }
    
    async __parseStorage(blob) {
        var dv = new DataView(await blob.arrayBuffer());
        
        var data = {};
        
        data["magik"] = dv.getUint32(0x00, false) === 0xBADD0BEE;
    
        data["records"] = {};
        
        if (data["magik"]) {
            var records = await this.__sliceStorage(blob);
            
            for(var i in records) {
                records[i] = await this.__parseRecord(records[i]);
                
                // Throwing away non-python stuff, for convinience.
                if (records[i].type !== 'py') records.splice(i, 1);
            }
            
            data["records"] = records;
        }
        
        return data;
    }
    
    async __encodePyRecord(record) {
        var content = new TextEncoder("utf-8").encode(record.code);
        
        record.data = new Blob([
            concatTypedArrays(
                new Uint8Array([record.autoImport ? 1 : 0]),
                concatTypedArrays(
                    content,
                    new Uint8Array([0])
                )
            )
        ]);
        
        delete record.autoImport;
        delete record.code;
        
        return record;
    }
    
    __getRecordEncoders() {
        return {
            py: this.__encodePyRecord.bind(this)
        };
    }
    
    async __assembleStorage(records, maxSize) {
        const encoder = new TextEncoder();
        
        var data = new Uint8Array([0xBA, 0xDD, 0x0B, 0xEE]); // Magic value 0xBADD0BEE (big endian)
        
        for(var i in records) {
            var record = records[i];
            var name = record.name + "." + record.type;
            
            var encoded_name = concatTypedArrays(
                encoder.encode(name),
                new Uint8Array([0])
            );
            
            var encoded_content = concatTypedArrays(
                encoded_name,
                new Uint8Array(await record.data.arrayBuffer())
            );
            
            var length_buffer = new Uint8Array([0xFF, 0xFF]);
            
            encoded_content = concatTypedArrays(length_buffer, encoded_content);
            
            var dv = new DataView(encoded_content.buffer);
            dv.setUint16(0, encoded_content.length, true);
            
            if (data.length + encoded_content.length + 2 > maxSize) {
                console.error("Too much data!");
                throw new Error("Too much data!");
            }
            
            data = concatTypedArrays(data, encoded_content);
        }
        
        data = concatTypedArrays(data, new Uint8Array([0, 0]));
        
        return new Blob([data]);
    }
    
    async __encodeRecord(record) {
        var encoders = this.__getRecordEncoders();
        
        if (record.type in encoders) {
            record = encoders[record.type](record);
        }
        
        return record;
    }
    
    async __encodeStorage(data, size) {
        for(var i in data.records) {
            data.records[i] = await this.__encodeRecord(data.records[i]);
            
        }
        
        return await this.__assembleStorage(data.records, size);
    }
    
    async __reinstallStorage() {
        let pinfo = await this.__getPlatformInfo();
        
        let storage_blob = await this.__encodeStorage(this.storage_content, pinfo["storage"]["size"]);
        await this.__flashStorage(pinfo["storage"]["address"], await storage_blob.arrayBuffer());
        
        this.storage_content = null;
        this.waiting_for_flash = false;
        
        this.installInstance.installationFinished();
    }
    
    async install() {
        console.log("install version" + this.toInstall + "/" + this.installInstance.state.model);
        
        var _this = this;
        this.device.logProgress = function(done, total) {
            _this.installInstance.setProgressPercentage(done / total * 100);
        };
        
        let pinfo = await this.__getPlatformInfo();
        
        let storage_blob = await this.__retreiveStorage(pinfo["storage"]["address"], pinfo["storage"]["size"]);
        
        this.storage_content = await this.__parseStorage(storage_blob);
        
        // return;
        
        var callback = function() {
            this.waiting_for_flash = true;
            this.autoConnect(0x0483, 0xa291);
        }.bind(this);
        
        if (!DO_DRY_RUN) {
            if (this.installInstance.state.model === "N0100") {
                await this.__installN0100(callback);
            } else {
                await this.__installN0110(callback);
            }
        } else {
            callback();
        }

        

        
        // this.installInstance.installationFinished();

    }
    
    async __installN0100(callback) {
        var _this = this;
        
        _this.__downloadFirmwareCheck(_this.installInstance.state.model, _this.toInstall, "epsilon.onboarding.internal.bin", async (internal_check, internal_blob) => {
            if (!internal_check) {
                _this.installInstance.calculatorError(true, "Download of internal seems corrupted, please retry.");
            }
            
            this.ignore_disconnect = true;
            
            _this.device.startAddress = 0x08000000;
            await _this.device.do_download(_this.transferSize, await internal_blob.arrayBuffer(), true);
            
            callback();
        });
    }
    
    async __installN0110(callback) {
        var _this = this;
        
        this.__downloadFirmwareCheck(this.installInstance.state.model, this.toInstall, "epsilon.onboarding.external.bin", async (external_check, external_blob) => {
            if (!external_check) {
                _this.installInstance.calculatorError(true, "Download of external seems corrupted, please retry.");
            }
            
            _this.__downloadFirmwareCheck(_this.installInstance.state.model, _this.toInstall, "epsilon.onboarding.internal.bin", async (internal_check, internal_blob) => {
                if (!internal_check) {
                    _this.installInstance.calculatorError(true, "Download of internal seems corrupted, please retry.");
                }
                
                _this.device.startAddress = 0x90000000;
                await _this.device.do_download(_this.transferSize, await external_blob.arrayBuffer(), false);
                    
                this.ignore_disconnect = true;
                
                _this.device.startAddress = 0x08000000;
                await _this.device.do_download(_this.transferSize, await internal_blob.arrayBuffer(), true);
            
                callback();
            });
        });
    }
    
    detect() {
        this.installInstance.calculatorError(false, null);
        navigator.usb.requestDevice({ 'filters': [{'vendorId': 0x0483, 'productId': 0xa291}]}).then(
            async selectedDevice => {
                let interfaces = DFU.findDeviceDfuInterfaces(selectedDevice);
                await fixInterfaceNames(selectedDevice, interfaces);
                this.device = await this.__connect(new DFU.Device(selectedDevice, interfaces[0]));
                
                await this.__setCalculatorInfos();
            }
        ).catch(error => {
            this.installInstance.calculatorError(true, error);
        });
    }
    
    __findMatchingDevices(vid, pid, serial, dfu_devices) {
        let matching_devices = [];
        for (let dfu_device of dfu_devices) {
            if (serial) {
                if (dfu_device.device_.serialNumber === serial) {
                    matching_devices.push(dfu_device);
                }
            } else {
                if (
                    (!pid && vid > 0 && dfu_device.device_.vendorId  === vid) ||
                    (!vid && pid > 0 && dfu_device.device_.productId === pid) ||
                    (vid > 0 && pid > 0 && dfu_device.device_.vendorId  === vid && dfu_device.device_.productId === pid)
                   )
                {
                    matching_devices.push(dfu_device);
                }
            }
        }
        
        return matching_devices;
    }
    
    async __autoConnectDevice(device) {
        let interfaces = DFU.findDeviceDfuInterfaces(device.device_);
        await fixInterfaceNames(device.device_, interfaces);
        device = await this.__connect(new DFU.Device(device.device_, interfaces[0]));
        console.log("Autoconnected to device:", device);
        return device;
    }
    
    stopAutoConnect() {
        clearTimeout(this.autoconnectId);
        
        this.autoconnectId = 0;
    }
    
    autoConnect(vid, pid, serial) {
        var _this = this;
        DFU.findAllDfuInterfaces().then(async dfu_devices => {
            let matching_devices = _this.__findMatchingDevices(vid, pid, serial, dfu_devices);
            
            if (matching_devices.length !== 0) {
                this.stopAutoConnect();
                
                this.device = await this.__autoConnectDevice(matching_devices[0]);
                
                if (this.waiting_for_flash) {
                    await this.__reinstallStorage();
                } else {
                    this.installInstance.calculatorError(false, null);
                    await this.__setCalculatorInfos();
                }
                
                
            }
        });
        
        this.autoconnectId = setTimeout(this.autoConnect.bind(this, vid, pid), AUTOCONNECT_DELAY);
    }
    
    onUnexpectedDisconnect(event) {
        if (this.device !== null && this.device.device_ !== null) {
            if (this.device.device_ === event.device) {
                this.device.disconnected = true;
                if (this.ignore_disconnect === false)
                    this.installInstance.calculatorError(true, event);
                this.device = null;
            }
        }
        
        this.autoConnect(0x0483, 0xa291);
    }
}















function readFString(dv, index, len) {
    var out = "";
    for(var i = 0; i < len; i++) {
        var chr = dv.getUint8(index + i);
        
        if (chr === 0) {
            break;
        }
        
        out += String.fromCharCode(chr);
    }
    
    return out;
}

function parsePlatformInfo(array) {
    var dv = new DataView(array);
    // console.log(hexBuffer(array));
    var data = {};
    
    data["magik"] = dv.getUint32(0x00, false) === 0xF00DC0DE;
    
    data["magik"] = dv.getUint32(0x00, false) === 0xF00DC0DE;
    
    if (data["magik"]) {
        data["oldplatform"] = !(dv.getUint32(0x1C, false) === 0xF00DC0DE);
        
        data["omega"] = {};
        
        if (data["oldplatform"]) {
            data["omega"]["installed"] = dv.getUint32(0x1C + 8, false) === 0xF00DC0DE || dv.getUint32(0x1C + 16, false) === 0xDEADBEEF || dv.getUint32(0x1C + 32, false) === 0xDEADBEEF;
            if (data["omega"]["installed"]) {
                data["omega"]["version"] = readFString(dv, 0x0C, 16);
                
                data["omega"]["user"] = "";
                
            }
            
            data["version"] = readFString(dv, 0x04, 8);
            var offset = 0;
            if (dv.getUint32(0x1C + 8, false) === 0xF00DC0DE) {
                offset = 8;
            } else if (dv.getUint32(0x1C + 16, false) === 0xF00DC0DE) {
                offset = 16;
            } else if (dv.getUint32(0x1C + 32, false) === 0xF00DC0DE) {
                offset = 32;
            }
            
            data["commit"] = readFString(dv, 0x0C + offset, 8);
            data["storage"] = {};
            data["storage"]["address"] = dv.getUint32(0x14 + offset, true);
            data["storage"]["size"] = dv.getUint32(0x18 + offset, true);
        } else {
            data["omega"]["installed"] = dv.getUint32(0x20, false) === 0xDEADBEEF && dv.getUint32(0x44, false) === 0xDEADBEEF;
            if (data["omega"]["installed"]) {
                data["omega"]["version"] = readFString(dv, 0x24, 16);
                data["omega"]["user"] = readFString(dv, 0x34, 16);
            }

            data["version"] = readFString(dv, 0x04, 8);
            data["commit"] = readFString(dv, 0x0C, 8);
            data["storage"] = {};
            data["storage"]["address"] = dv.getUint32(0x14, true);
            data["storage"]["size"] = dv.getUint32(0x18, true);
        }
    } else {
        data["omega"] = false;
    }
    
    return data;
}

function concatTypedArrays(a, b) {
    // Checks for truthy values on both arrays
    if(!a && !b) throw new Error('Please specify valid arguments for parameters a and b.');  

    // Checks for truthy values or empty arrays on each argument
    // to avoid the unnecessary construction of a new array and
    // the type comparison
    if(!b || b.length === 0) return a;
    if(!a || a.length === 0) return b;

    // Make sure that both typed arrays are of the same type
    if(Object.prototype.toString.call(a) !== Object.prototype.toString.call(b))
        throw new Error('The types of the two arguments passed for parameters a and b do not match.');

    var c = new a.constructor(a.length + b.length);
    c.set(a);
    c.set(b, a.length);

    return c;
}

function getDFUDescriptorProperties(device) {
    // Attempt to read the DFU functional descriptor
    // TODO: read the selected configuration's descriptor
    return device.readConfigurationDescriptor(0).then(
        data => {
            let configDesc = DFU.parseConfigurationDescriptor(data);
            let funcDesc = null;
            let configValue = device.settings.configuration.configurationValue;
            if (configDesc.bConfigurationValue === configValue) {
                for (let desc of configDesc.descriptors) {
                    if (desc.bDescriptorType === 0x21 && desc.hasOwnProperty("bcdDFUVersion")) {
                        funcDesc = desc;
                        break;
                    }
                }
            }

            if (funcDesc) {
                return {
                    WillDetach:            ((funcDesc.bmAttributes & 0x08) !== 0),
                    ManifestationTolerant: ((funcDesc.bmAttributes & 0x04) !== 0),
                    CanUpload:             ((funcDesc.bmAttributes & 0x02) !== 0),
                    CanDnload:             ((funcDesc.bmAttributes & 0x01) !== 0),
                    TransferSize:          funcDesc.wTransferSize,
                    DetachTimeOut:         funcDesc.wDetachTimeOut,
                    DFUVersion:            funcDesc.bcdDFUVersion
                };
            } else {
                return {};
            }
        },
        error => {}
    );
}

async function fixInterfaceNames(device_, interfaces) {
    // Check if any interface names were not read correctly
    if (interfaces.some(intf => (intf.name === null))) {
        // Manually retrieve the interface name string descriptors
        let tempDevice = new DFU.Device(device_, interfaces[0]);
        await tempDevice.device_.open();
        let mapping = await tempDevice.readInterfaceNames();
        await tempDevice.close();

        for (let intf of interfaces) {
            if (intf.name === null) {
                let configIndex = intf.configuration.configurationValue;
                let intfNumber = intf["interface"].interfaceNumber;
                let alt = intf.alternate.alternateSetting;
                intf.name = mapping[configIndex][intfNumber][alt];
            }
        }
    }
}
