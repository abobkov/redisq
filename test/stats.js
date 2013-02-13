var assert = require("assert"),
    Stats = require("../lib/stats");

    var qrecords = ['[1360684264000,100,10,1,200,500,1000]',
                    '[1360684264000,200,20,2,250,550,2000]',
                    '[1360684265000,300,30,3,300,600,3000]',
                    '[1360684265000,400,40,4,350,650,4000]',
                    '[1360684265000,500,50,5,400,700,5000]',
                    '[1360684267000,600,60,6,450,750,6000]' ]

describe("/stats", function() {
    describe("#recalculateHistory", function() {
        var qstats = new Stats("test"),
            done_records= [1360684260000,2100,210,21,46,110,284],
            recalc_records = qstats.recalculateHistory(qrecords).shift();

        it("should return equal length", function() {
                assert.equal(recalc_records.length, done_records.length);
        });

        it("should return equal values", function() {
                for (var i = 0; i < done_records.length; i++) {
                    assert.equal(recalc_records[i], done_records[i]);
                }
        });
    });
});