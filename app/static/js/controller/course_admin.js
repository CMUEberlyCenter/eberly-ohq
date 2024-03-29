var course_admin_ctl = ["$scope","$rootScope","$db","$http",function($scope,$rootScope,$db,$http) {
	$rootScope.$db = $db;
	$rootScope.current_page = "course_admin";
	$rootScope.check_login();

  // model for editing user role
  $scope.edit_user = {
    role: ''
  }

  // variables for modifying a course
  $scope.selected_del_course = "unknown";
  $scope.selected_del_active = false;
  $scope.selected_del_id = -1;

  $scope.selected_edit = undefined;

	$scope.find_id = function (course_num) {
		for(var i = 0; i < $scope.courses.length; i++) {
      if ($scope.courses[i].number == course_num) {
        return $scope.courses[i].id;
      }
    }
	}

  $scope.add_course = function () {
    var course_num = parseInt($("#new_course_num").val(), 10)
    var course_payload = {
      number: course_num,
      name: $("#new_course_name").val()
    }

    $http.post("/api/course/add", course_payload).then(function(success) {
			$('#modal_add_course').closeModal();
			Materialize.toast('Saved', 5000);
			$scope.get_courses();
    }, function(fail) {
      Materialize.toast('There was an error', 5000);
    });
  }

  $scope.select_edit = function (course) {
    $scope.selected_edit = course;
  }

  $scope.edit_course = function () {
    var payload = {
      id: $scope.selected_edit.id,
      number: parseInt($('#edit_course_num').val()),
      name: $('#edit_course_name').val(),
      color: $('#edit_course_color').val(),
      label: $('#edit_course_label').val()
    }

    $http.post("/api/course/edit", payload).then(function(success) {
      Materialize.toast('Saved', 5000);
			$scope.get_courses();
      $('#modaledit').closeModal();
    }, function(fail) {
      Materialize.toast('There was an error', 5000);
    });
  }

  $scope.get_name = function (num, courses) {
    var course = courses.find(c => c['number'] == num);
    return course['name'];
  }

  $scope.add_no_questions = function (data) {
    var q_courses = data.map(c => c['number']);
    var all_courses = $scope.courses.map(c => c['number']);
    var no_q_courses = all_courses.filter(c => !q_courses.includes(c));
    var add_zeroes = no_q_courses.map(c => ({number: c,
                                            name: $scope.get_name(c, $scope.courses),
                                            count: 0}));
    return data.concat(add_zeroes);
  }

  $scope.get_counts = function () {
    $http.get("/api/course/get_counts").then(function (success) {
      $scope.course_stats = $scope.add_no_questions(success.data);
    }, function (fail) {
      Materialize.toast('Stats fukt', 5000);
    })
  }

  $scope.get_courses = function () {
    $http.get("/api/course/get_all").then(function(success) {
      $scope.courses = success.data;
      $scope.get_counts();
    }, function(fail) {
      Materialize.toast('There was an error', 5000);
    });
  }
  $scope.get_courses();

  $scope.select = function (del_item, del_id, del_active) {
    $scope.selected_del_course = del_item;
    $scope.selected_del_id = del_id;
    $scope.selected_del_active = del_active;
  }

  $scope.enable_disable_course = function () {
    var payload = {
      id: $scope.selected_del_id,
      active: !($scope.selected_del_active)
    }

    $http.post("/api/course/edit", payload).then(function(success) {
      Materialize.toast('Saved', 5000);
			$scope.get_courses();
      $('#modal_edit_course').closeModal();
    }, function(fail) {
      Materialize.toast('There was an error', 5000);
    });
  }

  $scope.submit_roles = function(people) {
			people = people.filter((person) => person != "");
      var payload = {
				"andrew_ids": people,
				"course_id": $scope.find_id(parseInt($("#batch_course_num").val(), 10)),
				"role": "ca"
      }
			$http.post("/api/role/set_admin", payload).then(function(success) {
				Materialize.toast('TAs Added', 5000);
			}, function(fail) {
				Materialize.toast('There was an error', 5000);
			});
  }

  $scope.batch_role = function () {
    var input, file, fr, result;
    input = document.getElementById('csv_input');
    file = input.files[0]
    fr = new FileReader();
    fr.onload = function(e) {
      $scope.submit_roles(e.target.result.split("\n"));
    }
    fr.readAsText(file);
  }

}];
