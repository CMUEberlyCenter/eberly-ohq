var queue = require('./queue');
var auth = require('../../auth');

module.exports = function(io) {

  // make sure that this endpoint is protected
  io.use(auth.ioIsAuthenticated);

  // on client connection, join appropriate room, and
  // handle subsequent client -> server communications
  io.on('connection', function(socket) {
    var userid = socket.request.user.id;
    if (socket.request.user.role === 'ca') {
      socket.join('ca');
      oncajoin(socket, userid);
    } else if (socket.request.user.role === 'student') {
      socket.join('student');
      onstudentjoin(socket, userid);
    } else {
      throw new Error('Not authorized');
    }
  });

  // ca/student global rooms
  var cas = io.to('ca');
  var students = io.to('student');


  //
  // CA handling
  //

  // individual cas
  var oncajoin = function(socket, userid) {

    // listen for events
    socket.on('freeze_question', function() {

    });

    socket.on('kick_question', function() {

    });

    socket.on('finish_question', function() {

    });

    socket.on('answer_question', function() {

    });
    
    socket.on('close_queue', function() {
      queue.meta.close();
    });

    socket.on('open_queue', function() {
      queue.meta.open();
    });

    socket.on('update_minute_rule', function(minutes) {
      queue.meta.setTimeLimit(minutes);
    });

    // emit the current data on connect
    queue.meta.getCurrent().then(function(meta) {
      socket.emit('queue_meta', makeMessage('update', meta));
    });

  };

  // server -> client
  (function() {
    queue.meta.emitter.on('update', function(meta) {
      cas.emit('queue_meta', makeMessage('update', meta));
    });
  })();


  //
  // Student handling
  //

  // individual students
  var onstudentjoin = function(socket, userid) {

  };

  //
  // utilities
  //
  var makeMessage = function(type, payload) {
    return {
      type: type,
      payload: payload
    };
  };

};
