$(function(){

    // Get Coordinates from OpenStreetMap, needed to find county name
    var Coordinates = Backbone.Model.extend({
        url: function() {
            return 'http://nominatim.openstreetmap.org/search?q=' + _.values(this.attributes).join(', ') + '&format=json';
        }
    });

    // County model, needed to find locally available healthcare plans
    var County = Backbone.Model.extend({
        url: 'http://data.fcc.gov/api/block/find',
        sync: function(method, model, options) {
            var location = new Location(model.attributes);
            location.fetch({
                success: function(location) {
                    if (location.get('latitude') && location.get('longitude')) {
                        model.injection(location.attributes);
                    } else {
                        var coordinates = new Coordinates(location.attributes);
                        coordinates.fetch({
                            success: function(coordinates) {
                                model.injection({
                                    latitude: coordinates.get(0).lat,
                                    longitude: coordinates.get(0).lon
                                });
                            }
                        });
                    }
                }
            });
        },
        callback: 'gotCounty',
        // Use script injection to work around same-origin policy
        injection: function(location) {
            var src = this.url + '?latitude=' + location.latitude + '&longitude=' + location.longitude + '&showall=false&format=jsonp&callback=' + this.callback;
            var $script = $('<script>')
                .attr('type', 'application/javascript')
                .attr('src', src);

            $('body').append($script);
        }
    });
    window.gotCounty = function(county) {
        $('body').trigger('gotCounty', new County(county));
    }

    // Location model
    var Location = Backbone.Model.extend({
        url: 'https://freegeoip.net/json/',
        sync: function(method, model, options) {
            if (_.isEmpty(model.attributes)) {
                $.getJSON(model.url, options.success);
            } else {
                (new Coordinates(model.toJSON())).fetch({
                    success: function(coordinates) {
                        if (coordinates.get(0)) {
                            model.set({
                                latitude: parseFloat(coordinates.get(0).lat),
                                longitude: parseFloat(coordinates.get(0).lon)
                            });
                        }
                        options.success(model.attributes);
                    }
                });
            }
        }
    });

    // Hospital model
    var Hospital = Backbone.Model.extend({
        initialize: function() {
            var hospital = this;
            this.getDistance();
            (new HospitalMeasures({id: this.get('provider_number')})).fetch({
                success: function(measures) {
                    hospital.set({measures: measures});
                }
            });
        },
        getDistance: function() {
            var currentLatitude = this.get('currentLocation').get('latitude'),
                currentLongitude = this.get('currentLocation').get('longitude'),
                hospitalLatitude = this.get('location').latitude,
                hospitalLongitude = this.get('location').longitude;

            //var R = 6371; // Radius of Earth in km
            var R = 3959; // Radius of Earth in miles
            var a = 0.5 - Math.cos((hospitalLatitude - currentLatitude) * Math.PI / 180)/2 + Math.cos(currentLatitude * Math.PI / 180) * Math.cos(hospitalLatitude * Math.PI / 180) * (1 - Math.cos((hospitalLongitude - currentLongitude) * Math.PI / 180))/2;
            var distance = R * 2 * Math.asin(Math.sqrt(a));
            this.set({distance: distance.toFixed(1)});
        }
    });

    // Get registered structural measures for a hospital
    var HospitalMeasures = Backbone.Model.extend({
        url: function() {
            return 'http://data.medicare.gov/resource/easc-zwde.json?$select=measure_name,measure_response&provider_number=' + this.id;
        },
        sync: function(method, model, options) {
            $.getJSON(_.result(model, 'url'), function(data) {
                var measures = {};
                _.each(data, function(measure) {
                    if (_.contains(['Y', 'Yes'], measure.measure_response)) {
                        measures[measure.measure_name] = true;
                    } else if (!_.contains(['Not Available'], measure.measure_response)) {
                        measures[measure.measure_name] = false;
                    } else {
                        measures[measure.measure_name] = null;
                    }
                });
                options.success({measures: measures});
            });
        }
    });

    // Hospital collection for a specific geographic location
    var HospitalList = Backbone.Collection.extend({
        model: Hospital,
        url: 'http://data.medicare.gov/resource/v287-28n3.json',
        comparator: function(hospital) {
            return parseFloat(hospital.get('distance'));
        },
        sync: function(method, collection, options) {
            var location = new Location(options.location);
            location.fetch({
                success: function(location) {
                    var query = '?';
                    if (location.get('zipcode')) {
                        query += "$where=starts_with(zip_code, '" + location.get('zipcode').substr(0, 3) + "')";
                    } else {
                        query += 'state=' + (location.get('state') || location.get('region_code')) + '&city=' + location.get('city');
                    }
                    $.getJSON(collection.url + query, function(hospitals) {
                        hospitals = _.map(hospitals, function(hospital) {
                            hospital.currentLocation = location;
                            return hospital;
                        });
                        options.success(hospitals);
                    });
                }
            });
        }
    });

    var Hospitals = new HospitalList();

    // Healthcare plan model
    var Plan = Backbone.Model.extend({
        defaults: { plan_brochure_url: {url: ''} }
    });

    // Healthcare plan collection for a specific geographic location
    var PlanList = Backbone.Collection.extend({
        model: Plan,
        url: 'https://data.healthcare.gov/resource/b8in-sz6k.json',
        comparator: 'premium_adult_individual_age_30',
        sync: function(method, collection, options) {
            var county = new County(options.location);
            county.fetch();
            $('body').on('gotCounty', function(e, county) {
                var query = '?';
                if (county.get('State').code && county.get('County').name) {
                    query += 'state=' + county.get('State').code + '&county=' + county.get('County').name;
                }
                $.getJSON(collection.url + query, options.success);
            });
        }
    });

    var Plans = new PlanList();

    // Measures view
    var MeasuresView = Backbone.View.extend({
        tagName: 'ul',
        className: 'list-unstyled small',
        template: _.template($('#measures-template').html()),
        render: function() {
            this.$el.html(this.template(this.model.toJSON()));
            return this;
        }
    });

    // Hospital view
    var HospitalView = Backbone.View.extend({
        tagName: 'li',
        template: _.template($('#hospital-template').html()),
        initialize: function() {
            this.listenTo(this.model, 'change:id', this.render);
            this.listenTo(this.model, 'change:measures', this.addMeasures);
        },
        render: function() {
            this.$el.html(this.template(this.model.toJSON()));
            return this;
        },
        addMeasures: function() {
            var view = new MeasuresView({model: this.model.get('measures')});
            this.$('#hospital-' + this.model.get('provider_number')).append(view.render().el);
        }
    });

    // Plan view
    var PlanView = Backbone.View.extend({
        tagName: 'li',
        template: _.template($('#plan-template').html()),
        initialize: function() {
            this.listenTo(this.model, 'change', this.render);
        },
        render: function() {
            this.$el.html(this.template(this.model.toJSON()));
            return this;
        }
    });

    // General application view
    var AppView = Backbone.View.extend({
        el: $('#healthfinder'),
        initialize: function() {
            var self = this;
            this.listenTo(Hospitals, 'sort', this.addHospitals);
            this.listenTo(Hospitals, 'reset', this.clearHospitals);
            Hospitals.fetch();
            this.listenTo(Plans, 'sort', this.addPlans);
            this.listenTo(Plans, 'reset', this.clearPlans);
            Plans.fetch();
        },
        render: function() {
            return this;
        },
        events: {
            'click #search-submit': 'updateLocation'
        },
        addHospitals: function(hospitals) {
            var $hospitalList = this.$('#hospital-list');
            hospitals.forEach(function(hospital) {
                var view = new HospitalView({model: hospital});
                $hospitalList.append(view.render().el);
            });
        },
        clearHospitals: function() {
            this.$('#hospital-list').empty();
        },
        addPlans: function(plans) {
            var $planList = this.$('#plan-list');
            plans.forEach(function(plan) {
                var view = new PlanView({model: plan});
                $planList.append(view.render().el);
            });
        },
        clearPlans: function() {
            this.$('#plan-list').empty();
        },
        updateLocation: function(event) {
            event.preventDefault();
            var location = {};
            $('form#search-form').find('input,select').each(function() {
                if ($(this).val()) {
                    location[$(this).attr('id').replace('search-', '')] = $(this).val();
                }
            });
            Hospitals.reset();
            Hospitals.fetch({location: location});
            Plans.reset();
            Plans.fetch({location: location});
        }
    });
    var App = new AppView;
});
