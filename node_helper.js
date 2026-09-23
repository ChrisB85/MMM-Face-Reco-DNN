/* Magic Mirror
 * Module: MMM-Face-Reco-DNN
 *
 * By Thierry Nischelwitzer http://nischi.ch
 * MIT Licensed.
 */

/*global require, module, log*/

'use strict';

const NodeHelper = require('node_helper');
const { PythonShell } = require('python-shell');
const onExit = require('signal-exit');
const path = require('path');
const fs = require('fs');
var pythonStarted = false;
// Users the recognition process has logged in and not yet out; needed to log
// them out when the process is restarted after training.
const loggedIn = new Set();
const ADMIN_DEFAULTS = {
  enabled: false,
  pin: '',
  cameraFrameUrl: 'http://127.0.0.1:1984/api/frame.jpeg?src=c925e_face',
};

module.exports = NodeHelper.create({
  pyshell: null,
  python_start: function () {
    const self = this;
    const extendedDataset = this.config.extendDataset ? 'True' : 'False';
    const options = {
      mode: 'json',
      pythonOptions: ['-u'], // Immediately flush buffer for std out/in monitoring/writing to work
      stderrParser: line => JSON.stringify(line),
      // A non-JSON line on stdout (a stray print() in Python or a library)
      // makes python-shell's JSON parser throw, which silently stops all
      // further messages from recognition. Pass such lines on as status.
      parser: line => {
        try {
          return JSON.parse(line);
        } catch {
          return { status: line };
        }
      },
      args: [
        '--cascade=' + this.config.cascade,
        '--encodings=' + this.config.encodings,
        '--rotateCamera=' + this.config.rotateCamera,
        '--method=' + this.config.method,
        '--detectionMethod=' + this.config.detectionMethod,
        '--interval=' + this.config.checkInterval,
        '--output=' + this.config.output,
        '--outputmm=' + this.config.outputmm,
        '--extendDataset=' + extendedDataset,
        '--dataset=' + this.config.dataset,
        '--tolerance=' + this.config.tolerance,
        '--brightness=' + this.config.brightness,
        '--contrast=' + this.config.contrast,
        '--resolution=' + this.config.resolution.join(','),
        '--processWidth=' + this.config.processWidth,
        '--run-only-on-notification=' + (this.config.external_trigger_notification !== '' ? '1' : '0'),
        '--useMjpgStreamer=' + (this.config.useMjpgStreamer ? 'True' : 'False'),
        '--mjpgStreamerUrl=' + this.config.mjpgStreamerUrl,
        '--mjpgStreamerUser=' + this.config.mjpgStreamerUser,
        '--mjpgStreamerPassword=' + this.config.mjpgStreamerPassword,
      ],
    };

    if (this.config.pythonPath != null && this.config.pythonPath !== '') {
      options.pythonPath = this.config.pythonPath;
    }

    // Start face reco script
    const shell = new PythonShell('modules/' + this.name + '/tools/recognition.py', options);
    self.pyshell = shell;

    // check if a message of the python script is comming in
    shell.on('message', function (message) {
      // A process killed by python_restart can still print its last login or
      // logout; only the current process may change who is logged in.
      if (shell !== self.pyshell) return;

      // A status message has received and will log
      if (Object.prototype.hasOwnProperty.call(message, 'status')) {
        console.log('[' + self.name + '] ' + message.status);
      }

      // Somebody new are in front of the camera, send it back to the Magic Mirror Module
      if (Object.prototype.hasOwnProperty.call(message, 'camera_image')) {
        self.sendSocketNotification('camera_image', {
          image: message.camera_image.image,
        });
      }

      // Check if we get an image to show in the mirror
      if (Object.prototype.hasOwnProperty.call(message, 'login')) {
        console.log('[' + self.name + '] ' + 'Face recognition: Users ' + message.login.names.join(' - ') + ' detected and logging in.');
        message.login.names.forEach(name => loggedIn.add(name));
        self.sendSocketNotification('user', {
          action: 'login',
          users: message.login.names,
        });
      }

      // Somebody left the camera, send it back to the Magic Mirror Module
      if (Object.prototype.hasOwnProperty.call(message, 'logout')) {
        console.log('[' + self.name + '] ' + 'Face recognition: Users ' + message.logout.names.join(' - ') + ' no longer detected, logging out.');
        message.logout.names.forEach(name => loggedIn.delete(name));
        self.sendSocketNotification('user', {
          action: 'logout',
          users: message.logout.names,
        });
      }
    });

    // python_start runs again after every training; one exit hook is enough.
    if (!self.exitHooked) {
      self.exitHooked = true;
      onExit(function (_code, _signal) {
        self.destroy();
      });
    }
  },

  send_python_cmd: function (cmd) {
    this.pyshell.send(cmd);
  },

  python_stop: function () {
    this.destroy();
  },

  // The new process starts with nobody logged in and never reports a logout for
  // people the old one saw, so log them out here. Whoever is still in front of
  // the camera gets logged in again by the new process.
  python_restart: function () {
    console.log('[' + this.name + '] Model retrained, restarting recognition');
    // One notification per name: the front end handles one user per logout best.
    for (const name of loggedIn) {
      this.sendSocketNotification('user', { action: 'logout', users: [name] });
    }
    loggedIn.clear();
    this.pyshell.childProcess.kill();
    this.python_start();
  },

  admin_start: function () {
    const admin = Object.assign({}, ADMIN_DEFAULTS, this.config.admin);
    if (admin.enabled !== true) return;
    if (!admin.pin) {
      console.warn('[' + this.name + '] Admin UI not started: admin.pin is empty');
      return;
    }
    const dataset = path.resolve(global.root_path, this.config.dataset);
    const encodings = path.resolve(global.root_path, this.config.encodings);
    const { isServedPath } = require('./admin/lib');
    if (isServedPath(dataset, global.root_path) || isServedPath(encodings, global.root_path)) {
      console.error('[' + this.name + '] Admin UI not started: dataset and encodings must live outside directories MagicMirror serves (e.g. /home/dietpi/face-reco/)');
      return;
    }
    fs.mkdirSync(dataset, { recursive: true });

    const { createTrainer } = require('./admin/trainer');
    const { createAdminRouter } = require('./admin/routes');
    const trainer = createTrainer({
      pythonPath: this.config.pythonPath,
      script: path.join(this.path, 'tools', 'encode.py'),
      dataset,
      encodings,
      detectionMethod: this.config.detectionMethod,
      onTrained: () => this.python_restart(),
    });
    this.expressApp.use('/' + this.name + '/admin', createAdminRouter({ dataset, encodings, pin: String(admin.pin), cameraFrameUrl: admin.cameraFrameUrl, trainer }));
    console.log('[' + this.name + '] Admin UI at /' + this.name + '/admin/');
  },

  destroy: function () {
    const self = this
    this.pyshell.end(function (err) {
      if (err) throw err;
      console.log('[' + self.name + '] ' + 'finished running...');
    });

    console.log('[' + this.name + '] ' + 'Terminate python');
    this.pyshell.childProcess.kill();
  },

  socketNotificationReceived: function (notification, payload) {
    // Configuration are received
    if (notification === 'CONFIG') {
      this.config = payload;
      console.log('[' + this.name + '] Configuration received');
      console.log('[' + this.name + '] Camera type: ' + (this.config.useMjpgStreamer ? 'mjpg-streamer' : 'PiCamera2'));
      if (this.config.useMjpgStreamer) {
        console.log('[' + this.name + '] Mjpg-streamer URL: ' + this.config.mjpgStreamerUrl);
      }
      // Set static output to 0, because we do not need any output for MMM
      this.config.output = 0;
      if (!pythonStarted) {
        pythonStarted = true;
        console.log('[' + this.name + '] Starting Python face recognition process...');
        this.python_start();
        this.admin_start();
      }
    }

    // Notification for triggering face recognition received. Only send to python subprocess
    // if it has been started
    if (notification === this.config.external_trigger_notification && pythonStarted) {
      if (payload === true) {
        console.log('[' + this.name + '] External trigger: Starting face recognition');
        this.send_python_cmd('start');
      } else {
        console.log('[' + this.name + '] External trigger: Stopping face recognition');
        this.send_python_cmd('stop');
      }
    }
  },

  stop: function () {
    pythonStarted = false;
    this.python_stop();
  },
});
