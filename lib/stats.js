var redis = require(__dirname + '/redis'),
    async = require('async');

const
    STATS_FIELD_CREATED_AT      = 0,
    STATS_FIELD_PROCESSED       = 1,
    STATS_FIELD_FAILED          = 2,
    STATS_FIELD_CREATED         = 3,
    STATS_FIELD_TIME_STARTED    = 4,
    STATS_FIELD_TIME_PROCESSED  = 5,
    STATS_FIELD_TIME_FINISHED   = 6;

module.exports = (function(name, opts) {

    opts = opts || {};

    var self = this;
    var _redis = redis.client();

    this.name  = name;
    this.cnt   = {};
    this.timer = setInterval(_flush, 60000);
    this.historyLimit = 60 * 60 * 24 * 14 * 1000; // 2 weeks

    this.erase = function() {
        self.cnt = {
            failed:         0,
            processed:      0,
            created:        0,
            timeStarted:    0,
            timeProcessed:  0,
            timeFinished:   0
        };
    };

    this.normalize = function(opts, fn) {

        if (typeof opts == "function") {
            fn = opts;
            opts = {};
        }

        opts = opts || {};
        opts.grouping = opts.grouping || 'mm';

        var gMode = {
            'mm': 1,
            'hh': 3600000,
            'dd': 3600000 * 24
        };

        async.parallel([
            function(cb) { _redis.llen(_skey("queue"),             cb) },
            function(cb) { _redis.zrange(_skey("history"), 0, -1,  cb) },
            function(cb) { _redis.get(_skey("stats", "processed"), cb) },
            function(cb) { _redis.get(_skey("stats", "failed"),    cb) },
            function(cb) { _redis.get(_skey("stats", "created"),   cb) }
        ], function(err, replies) {

            if (err)
                throw new Error(err);

            var queued      = replies.shift(),
                records     = replies.shift(),
                processed   = parseInt(replies.shift()) || 0,
                failed      = parseInt(replies.shift()) || 0,
                created     = parseInt(replies.shift()) || 0;

            if (replies.length > 0)
                throw new Error("Crazy shit has happened here");

            var grouping = gMode[opts.grouping];
            if (records.length < 10) { grouping = gMode['mm'] }
            else if (records.length < 100) {
                if (opts.grouping == 'hh') { grouping = gMode['mm'] }
                else if (opts.grouping == 'dd') { grouping = gMode['hh'] }
            }

            var bydate = _groupingByDate(records, grouping),
                history = [];

            for (date in bydate)
                history.push({
                    "createdAt":        parseInt(date),
                    "processed":        bydate[date][STATS_FIELD_PROCESSED],
                    "failed":           bydate[date][STATS_FIELD_FAILED],
                    "created":          bydate[date][STATS_FIELD_CREATED],
                    "timeStarted":      bydate[date][STATS_FIELD_TIME_STARTED],
                    "timeProcessed":    bydate[date][STATS_FIELD_TIME_PROCESSED],
                    "timeFinished":     bydate[date][STATS_FIELD_TIME_FINISHED]
                });

            history.sort(function(a, b) {
                return a.createdAt - b.createdAt;
            });

            // calculating avg speed
            // (measured by last 10 minutes)
            var lastn = Math.min(10, history.length),
                handled = 0;

            for (var i = history.length - lastn; i < history.length; i++)
                handled += history[i].processed + history[i].failed;

            // handled tasks per minute
            var speed = (lastn > 0) ? handled / lastn : 0;
            speed = parseFloat(speed.toFixed(2));

            fn(null, {
                "speed": speed,
                "counters": {
                    "processed": processed || 0,
                    "failed":    failed || 0,
                    "created":   created || 0,
                    "queued":    queued
                },
                "history": history
            });
        });
    };

    this.countersReset = function(fn) {
        async.parallel([
            function(cb) { _redis.del(_skey("stats", "processed"), cb) },
            function(cb) { _redis.del(_skey("stats", "failed"),    cb) },
            function(cb) { _redis.del(_skey("stats", "created"),   cb) }
        ], fn);
    };

    this.historyReset = function(fn) {
        _redis.zremrangebyrank(_skey("history"), 0, -1, fn);
    };

    this.countersGet = function(fn) {
        async.parallel([
            function(cb) { _redis.llen(_skey("queue"),             cb) },
            function(cb) { _redis.get(_skey("stats", "processed"), cb) },
            function(cb) { _redis.get(_skey("stats", "failed"),    cb) },
            function(cb) { _redis.get(_skey("stats", "created"),   cb) }
        ], function(err, replies) {
            replies = replies || [];
            fn(err, {
                "queued":    parseInt(replies.shift()) || 0,
                "processed": parseInt(replies.shift()) || 0,
                "failed":    parseInt(replies.shift()) || 0,
                "created":   parseInt(replies.shift()) || 0
            }, self.name);
        });
    };

    function _flush(fn) {
        // nothing to save
        if (self.cnt.processed + self.cnt.created == 0)
            return fn ? fn() : null;

        // rounding to minute
        var now = Math.floor(new Date().getTime() / 60000) * 60000;

        var row = [];
        row[STATS_FIELD_CREATED_AT]      = now;
        row[STATS_FIELD_PROCESSED]       = self.cnt.processed;
        row[STATS_FIELD_FAILED]          = self.cnt.failed;
        row[STATS_FIELD_CREATED]         = self.cnt.created;
        row[STATS_FIELD_TIME_STARTED]    = self.cnt.timeStarted;
        row[STATS_FIELD_TIME_PROCESSED]  = self.cnt.timeProcessed;
        row[STATS_FIELD_TIME_FINISHED]   = self.cnt.timeFinished;

        async.parallel([
            function(cb) { _redis.zadd(_skey("history"), now, JSON.stringify(row),        cb) },
            function(cb) { _redis.incrby(_skey("stats", "processed"), self.cnt.processed, cb) },
            function(cb) { _redis.incrby(_skey("stats", "failed"), self.cnt.failed,       cb) },
            function(cb) { _redis.incrby(_skey("stats", "created"), self.cnt.created,     cb) }
        ], fn);

        _gc(now);

        self.erase();
    };

    function _gc(now, fn) {
        if (Math.random() > 0.01)
            return;

        if (typeof now != "number")
            now = new Date().getTime();

        _redis.zremrangebyscore(_skey("history"), 0, now - self.historyLimit, function(){
            _recalculateHistory(fn);
        });
    };

    function _skey() {
        var path = [ 'redisq', self.name ];
        for (var index in arguments)
            path.push(arguments[index]);
        return path.join(':');
    };

    function _groupingByDate(records, grouping) {
        var bydate = {},
            counts = {};

        for (var i = records.length - 1; i >= 0; i--) {
            var row  = JSON.parse(records[i]),
                date = Math.floor(row[0] / grouping) * grouping;

            if (date in bydate) {
                for (var j = row.length - 1; j >= 1; j--) {
                    bydate[date][j] += row[j];
                    counts[date]++;
                }
            }
            else {
                bydate[date] = row;
                counts[date] = 1;
            }

            for (element in bydate) {
                bydate[element][STATS_FIELD_TIME_STARTED] = Math.floor(bydate[element][STATS_FIELD_TIME_STARTED] / counts[elem]);
                bydate[element][STATS_FIELD_TIME_PROCESSED] = Math.floor(bydate[element][STATS_FIELD_TIME_PROCESSED] / counts[elem]);
                bydate[element][STATS_FIELD_TIME_FINISHED] = Math.floor(bydate[element][STATS_FIELD_TIME_FINISHED] / counts[elem]);
            }
        };
        return bydate;
    };

    function _recalculateHistory(fn) {
        _redis.zrange(_skey("history"), 0, -1,  function(err, records) {

            if (records.length > 0) {
                var grouping = 60000,
                    bydate = _groupingByDate(records, grouping);

                if (Object.keys(bydate).length > 0) {
                    _redis.zremrangebyrank(_skey("history"), 0, -1, function() {
                        for (date in bydate) {
                            var row = [];

                            row[STATS_FIELD_CREATED_AT]      = bydate[date][STATS_FIELD_CREATED_AT];
                            row[STATS_FIELD_PROCESSED]       = bydate[date][STATS_FIELD_PROCESSED];
                            row[STATS_FIELD_FAILED]          = bydate[date][STATS_FIELD_FAILED];
                            row[STATS_FIELD_CREATED]         = bydate[date][STATS_FIELD_CREATED];
                            row[STATS_FIELD_TIME_STARTED]    = bydate[date][STATS_FIELD_TIME_STARTED];
                            row[STATS_FIELD_TIME_PROCESSED]  = bydate[date][STATS_FIELD_TIME_PROCESSED];
                            row[STATS_FIELD_TIME_FINISHED]   = bydate[date][STATS_FIELD_TIME_FINISHED];

                            _redis.zadd(_skey("history"), row[STATS_FIELD_CREATED_AT], JSON.stringify(row));
                        }
                        fn();
                    });
                }
            }
        });
    };

    self.erase();
});
