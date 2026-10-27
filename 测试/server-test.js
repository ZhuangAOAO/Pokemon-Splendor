'use strict';

// 隔离联机回归：复用正式服务器代码，只把监听端口改为 3210。
require('../config.js');
global.NETWORK.port = 3210;
require('../server.js');
