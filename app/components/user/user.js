var db = require('../../db');
var dbEvents = require('../../db-events');
var EventEmitter = require('events');
var queueEvents = require('../queue/queue').questions.emitter;

var logger = require('../logging/logger');

function cleanUser(user) {
  user.auth_method = user.google_id === null ? 'local' : 'google';
  delete user.pw_bcrypt;
  delete user.is_temp_pw;
  delete user.google_id;
  return user;
};

// how long (in seconds) to consider a CA active after interacting with a question
const ACTIVE_TIMEOUT = 5 * 60;

//
// Users model
// events emitted:
//  cas_online, list of online cas
//  ca_count, count : int
//

var users = (function() {
  var result = {
    getUser: selectUserId,
    getActiveCas: selectActiveCas,
    emitter: new EventEmitter()
  };

  dbEvents.users.on("update", function (new_user,old_user) {
      logger.info('user update');
      if (new_user.first_name !== old_user.first_name) {
        //name change
        result.emitter.emit('name_change', cleanUser(new_user));
      }
  });


  // active ca event handling.
  // the code below handles scheduling CA count update events in the future.
  // for instance, if a CA answers a question, in ACTIVE_TIMEOUT seconds,
  // the server will schedule a recount of online CAs

  var emitActive = function(course_id) {
    logger.info('active cas');
    result.getActiveCas(course_id).then(function(cas) {
      result.emitter.emit('cas_active', cas, course_id);
    });
  };

  var delayEmitActive = function(course_id) {
    // add a second, just to make sure that the timeout has definitely passed
    setTimeout(() => emitActive(course_id), ACTIVE_TIMEOUT * 1000 + 1000);
  };

  // immediately update the CA count when a question is answered
  queueEvents.on('question_answered', (q) => emitActive(q.course_id));

  // these are the events that require recount scheduling
  queueEvents.on('question_closed', (q) => delayEmitActive(q.course_id));
  queueEvents.on('question_frozen', (q) => delayEmitActive(q.course_id));

  // on server startup, reschedule all previously scheduled updates
  var tminustimeout = 'NOW() - INTERVAL \'' + ACTIVE_TIMEOUT.toString() + ' seconds\'';
  db.union(function() {
      this.select('q.off_time as time', 'q.course_id as course_id')
          .from('questions as q')
          .whereNotNull('q.off_time')
          .andWhere('q.off_time', '>', db.raw(tminustimeout))
          .whereIn('q.off_reason', ['ca_kick', 'normal']);
    }, function() {
      this.select('q.frozen_time as time', 'q.course_id as course_id')
          .from('questions as q')
          .whereNotNull('q.frozen_time')
          .andWhere('q.frozen_time', '>', db.raw(tminustimeout));
    })
    .then(function(outputs) {
      for (var i = 0; i < outputs.length; i++) {
        var time = outputs[i].time;
        var course_id = outputs[i].course_id;
        var now = new Date();
        var toEmit = (ACTIVE_TIMEOUT * 1000) - (now.getTime() - time.getTime()) + 1000;
        if (toEmit > 0) {
          setTimeout(() => emitActive(course_id), toEmit);
        }
      }
    });

  return result;
})();

function selectDefaultUserFields() {
  return db.select(
      'u.id         AS id',
      'u.andrew_id  AS andrew_id',
      'u.email      AS email',
      'u.first_name AS first_name',
      'u.last_name  AS last_name',
      'u.is_online  AS is_online'
    )
    .from('users AS u');
}

function selectUserId(userid) {
  return selectDefaultUserFields()
    .where('u.id', userid)
    .first();
}

// Get the CAs which are currently active.
// Active CAs are CAs which:
//  - are currently answering a question
//  - have answered a question in the past 5 minutes
//  - have frozen a question in the past 5 minutes
function selectActiveCas(course_id) {
  logger.info('selectActiveCas');
  var active_timeout_sql = '(INTERVAL \'' + ACTIVE_TIMEOUT.toString() + ' seconds\')';

  return selectDefaultUserFields()
    .leftJoin('roles AS r', function() {
      this.on('u.id', 'r.user')
          .andOn(db.raw('r.course = ' + course_id));
    })
    .where('r.role', 'ca')
    .whereIn('u.id', function() {
      this.union(
        // all cas which are currently answering a question
        function() {
          this.select('q.ca_user_id as user_id')
              .from('questions as q')
              .whereNull('q.off_time');
        },
        // all cas which have answered a question in the last n mins
        function() {
          this.select('q.ca_user_id as user_id')
              .from('questions as q')
              .whereNotNull('q.off_time')
              .andWhere(db.raw('(NOW() - q.off_time) < ' + active_timeout_sql));
        },
        // all cas which have frozen a question in the last n mins
        function() {
          this.select('q.initial_ca_user_id as user_id')
              .from('questions as q')
              .whereNotNull('q.initial_ca_user_id')
              .andWhere(db.raw('(NOW() - q.frozen_time) < ' + active_timeout_sql));
        }
      );
    });
}

module.exports.users = users;
module.exports.cleanUser = cleanUser;
