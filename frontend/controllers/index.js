
var redisq = require('../../');

module.exports.index = function(req, res) {
    var qstats = [],
        counters = [];

    redisq.getQueues(function(err, queues) {
        for (elem in queues) {
            var stats = new Stats(elem)
            counters.push([stats, function(err, counters, qname){
                        qstats.push({ "qname": qname, "counters": counters })
                }]
            )
        }

        redisq.multiCountersGet(counters, function(){
            res.render("index", { stats: qstats });
        })
    });

    redisq.multiCountersGet = function(counters, cb) {
        var callCount = counters.length;

        counters.forEach(function(stats_fn){
            stats_fn[0].countersGet.call(stats_fn[0], function(err, counters, qname){
                stats_fn[1].apply(stats_fn[0], arguments);

                callCount--;
                if(callCount == 0){
                    cb();
                }
            })
        })
    }
};

