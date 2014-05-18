// Copyright © 2014 Nathan Vander Wilt. See the COPYRIGHT
// file at the top-level directory of this distribution.
//
// Licensed under the Apache License, Version 2.0 <LICENSE-APACHE or
// http://www.apache.org/licenses/LICENSE-2.0> or the BSD 2-Clause License
// <LICENSE-FREEBSD or http://opensource.org/licenses/BSD-2-Clause>, at your
// option. This file may not be copied, modified, or distributed
// except according to those terms.

var events = require('events');

/*
var _ = require('struct-fu');
var cmdStruct = _.struct([
    _.bool('start'),
    _.bool('tx'),
    _.ubit('command', 6),
    _.uint32('argument'),
    _.ubit('crc', 7),
    _.bool('end')
]);
*/

var CMD = {
    GO_IDLE_STATE: {index:0, format:'r1'},
    SEND_IF_COND: {index:8, format:'r7'},
    READ_OCR: {index:58, format:'r3'},
    SET_BLOCKLEN: {index:16, format:'r1'},
    
    APP_CMD: {index:55, format:'r1'},
    APP_SEND_OP_COND: {app_cmd:true, index:41, format:'r1'}
};

var RESP_LEN = {r1:1, r3:5, r7:5};

var R1_FLAGS = {
    IDLE_STATE: 0x01,
    ERASE_RESET: 0x02,
    ILLEGAL_CMD: 0x04,
    CRC_ERROR: 0x08,
    ERASE_SEQ: 0x10,
    ADDR_ERROR: 0x20,
    PARAM_ERROR: 0x40
};
R1_FLAGS._ANY_ERROR_ = R1_FLAGS.ILLEGAL_CMD | R1_FLAGS.CRC_ERROR | R1_FLAGS.ERASE_SEQ | R1_FLAGS.ADDR_ERROR| R1_FLAGS.PARAM_ERROR;

// CRC7 via https://github.com/hazelnusse/crc7/blob/master/crc7.cc
var crcTable = function (poly) {
    var table = new Buffer(256);
    for (var i = 0; i < 256; ++i) {
        table[i] = (i & 0x80) ? i ^ poly : i;
        for (var j = 1; j < 8; ++j) {
            table[i] <<= 1;
            if (table[i] & 0x80) table[i] ^= poly;
        }
    }
    return table;
}(0x89);
// spot check a few values, via http://www.cs.fsu.edu/~baker/devices/lxr/http/source/linux/lib/crc7.c
//if (crcTable[0] !== 0x00 || crcTable[7] !==  0x3f || crcTable[8] !== 0x48 || crcTable[255] !== 0x79) throw Error("Wrong table!")

function crcAdd(crc, byte) {
    return crcTable[(crc << 1) ^ byte];
}


// WORKAROUND: https://github.com/tessel/beta/issues/335
function reduceBuffer(buf, start, end, fn, res) {
    // NOTE: does not handle missing `res` like Array.prototype.reduce would
    for (var i = start; i < end; ++i) {
        res = fn(res, buf[i]);
    }
    return res;
}

exports.use = function (port) {
    var card = new events.EventEmitter(),
        spi = null;         // re-initialized to various settings until card is ready
    
    function configureSPI(mode, cb) {           // 'pulse', 'init', 'fullspeed'
        var pin = port.digital[1],
            cfg = { chipSelect: pin };
        if (mode === 'pulse') {
            // during pulse, CSN pin needs to be (and then remain) pulled high
            delete cfg.chipSelect;
            pin.output(true);
        }
        cfg.clockSpeed = (mode === 'fullspeed') ? 2*1000*1000 : 200*1000;
        spi = new port.SPI(cfg);
        //console.log("SPI is now", spi);
        spi.on('ready', cb);
    }
    
    var cmdBuffer = new Buffer(6 + 8 + 5);
    function sendCommand(cmd, arg, cb) {
        if (typeof arg === 'function') {
            cb = arg;
            arg = 0x00000000;
        }
        
        var command = CMD[cmd];
        if (command.app_cmd) {
            _sendCommand(CMD.APP_CMD.index, 0, function (e) {
                if (e) cb(e);
                else _sendCommand(command.index, arg, cb);
            });
        } else _sendCommand(command.index, arg, cb);
        
        function _sendCommand(idx, arg, cb) {
console.log('_sendCommand', idx, arg.toString(16));
            cmdBuffer[0] = 0x40 | idx;
            cmdBuffer.writeUInt32BE(arg, 1);
            //cmdBuffer[5] = Array.prototype.reduce.call(cmdBuffer.slice(0,5), crcAdd, 0) << 1 | 0x01;
            cmdBuffer[5] = reduceBuffer(cmdBuffer, 0, 5, crcAdd, 0) << 1 | 0x01;        // crc
            cmdBuffer.fill(0xFF, 6);
            console.log("* sending data:", cmdBuffer);
            spi.transfer(cmdBuffer, function (e,d) {
                console.log("TRANSFER RESULT", d);
                
                // response not sent until after command; it will start with a 0 bit
                var idx = 6, len = d.length,
                    size = RESP_LEN[command.format];
                while (idx < len && d[idx] & 0x80) ++idx;
                d = d.slice(idx, idx+size);
                var r1 = d[0];
                if (r1 & R1_FLAGS._ANY_ERROR_) cb(new Error("Error flag(s) set"), d);
                else cb(null, r1, d.slice(1));
            });
        }
    }
    
    
    function getCardReady(cb) {
        // see http://elm-chan.org/docs/mmc/gx1/sdinit.png
        // and http://elm-chan.org/docs/mmc/mmc_e.html
        // and https://www.sdcard.org/downloads/pls/simplified_specs/part1_410.pdf Figure 7-2
        // and http://eet.etec.wwu.edu/morrowk3/code/mmcbb.c
        
        
        var cardType = null;
        
        function checkVoltage(cb) {
            var condValue = 0x1AA;
            sendCommand('SEND_IF_COND', condValue, function (e,d,b) {
                var oldCard = (d & R1_FLAGS._ANY_ERROR_) === R1_FLAGS.ILLEGAL_CMD;
                if (e && !oldCard) return cb(new Error("Uknown card."));
                else if (oldCard) cardType = 'SDv1';            // TODO: or 'MMCv3'!
                
                var echoedValue = (b.readUInt16BE(2) & 0xFFF);
                if (echoedValue !== condValue) cb(new Error("Bad card voltage response."));
                else cb(null);
            });
        }
        
        function waitForReady(tries, cb) {
            if (tries > 100) cb(new Error("Timed out before card was ready."));
            sendCommand('APP_SEND_OP_COND', 1 << 30, function (e,d,b) {
                if (e) cb(e);
                else if (d) setTimeout(waitForReady.bind(null,tries+1,cb), 0);
                else cb(null, b);
            });
        }
        
        configureSPI('pulse', function () {
            // need to pull MOSI _and_ CS high for minimum 74 clock cycles at 100–400kHz
            console.log("Initial SPI ready, triggering native command mode.");
            var initLen = Math.ceil(74/8),
                initBuf = new Buffer(initLen);
            initBuf.fill(0xFF);
            spi.transfer(initBuf, function () {             // WORKAROUND: would use .send but https://github.com/tessel/beta/issues/336
                configureSPI('init', function () {
                    sendCommand('GO_IDLE_STATE', function (e,d) {
                        if (e) console.error(arguments), cb(new Error("Unknown or missing card."));
                        else checkVoltage(function (e) {
                            if (e) cb(e);
                            else waitForReady(0, function (e) {
                                if (cardType) fullSteamAhead();
                                else sendCommand('READ_OCR', function (e,d,b) {
                                    if (e) cb(new Error("Unexpected error reading card size!"));
                                    cardType = (b[0] & 0x40) ? 'SDv2+block' : 'SDv2';
                                    if (cardType === 'SDv2') sendCommand('SET_BLOCKLEN', 512, function (e) {
                                        if (e) cb(new Error("Unexpected error settings block length!"));
                                        else fullSteamAhead();
                                    }); else fullSteamAhead();
                                });
                                function fullSteamAhead() {
                                    console.log("Init complete, switching SPI to full speed.");
                                    configureSPI('fullspeed', function () {
                                        // now card should be ready!
                                        console.log("full steam ahead!");
                                        cb(null, cardType);
                                            // ARROW'ED!
                                    });
                                }
                            });
                        });
                    });
                });
            });
        });
    }
    getCardReady(function (e,d) {
        if (e) card.emit('error', e);
        else card.emit('ready');
        
        if (e) console.error("ERROR:", e);
        else console.log("Found card type", d);
    });
    
    return card;
};
