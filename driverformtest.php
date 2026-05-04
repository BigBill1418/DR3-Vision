<?php
session_start();
include "connection.php";

if ($_SERVER['REQUEST_METHOD'] == 'POST' && isset($_POST['submit'])) {
    $id = isset($_POST['id']) ? $_POST['id'] : '';
    $successMessage = "";

    // Check if formId is set in the URL
    if ($_SERVER["REQUEST_METHOD"] == "POST") {
        $user_id = $_POST['id'];

        if (
            isset($_POST['concatenatedData']) &&
            isset($_POST['totalMattresses']) &&
            isset($_FILES['image'])
        ) {
            $stacks = mysqli_real_escape_string($con, $_POST['concatenatedData']);
            $totalMattresses = mysqli_real_escape_string($con, $_POST['totalMattresses']);
            
            $pic_uploaded = 0;

            $imageExtension = strtolower(pathinfo($_FILES["image"]["name"], PATHINFO_EXTENSION));
            $uniqueFilename = uniqid() . '.' . $imageExtension;
            $targetDirectory = $_SERVER['DOCUMENT_ROOT'] . '/webapp/images/';

            if (!file_exists($targetDirectory)) {
                mkdir($targetDirectory, 0755, true);
            }

            if (move_uploaded_file($_FILES['image']['tmp_name'], $targetDirectory . $uniqueFilename)) {
                if (!in_array($imageExtension, ['jpg', 'jpeg', 'png'])) {
                    echo "Error: Please upload a photo with the extension .jpg, .jpeg, or .png";
                } else if ($_FILES["image"]["size"] > 2000000) {
                    echo "Error: Your photo exceeds the size of 2MB";
                } else {
                    $pic_uploaded = 1;
                }
            } else {
                echo "Error: File upload failed. Check your directory permissions.";
            }
        }

        if ($pic_uploaded == 1) {
            $imagePathInDatabase = '/webapp/images/' . $uniqueFilename;

            $sql = "UPDATE `truckloadinformationtable` SET `stacks` = '$stacks', `totalMattresses` = '$totalMattresses', `image` = '$imagePathInDatabase' WHERE `id` = $id";
            
            $query = mysqli_query($con, $sql);
            if ($query) {
                
                $successMessage = "Task added correctly";
            } else {
                echo 'Error Occurred: ' . mysqli_error($con);
            }
        }
    } else {
        echo 'Error: formId is not set in the URL.';
    }

    mysqli_close($con);
}
?>


<?php 
include "connection.php";

$sql = "SELECT * FROM truckloadinformationtable";
$result = $con->query($sql);
?>

<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">

    <link href="https://cdn.jsdelivr.net/npm/bootstrap@5.0.2/dist/css/bootstrap.min.css" rel="stylesheet" crossorigin="anonymous">
    <script src="https://ajax.googleapis.com/ajax/libs/jquery/3.5.1/jquery.min.js"></script>
    <script src="https://cdn.jsdelivr.net/npm/bootstrap@5.0.2/dist/js/bootstrap.bundle.min.js" integrity="sha384-MrcW6ZMFYlzcLA8Nl+NtUVF0sA7MsXsP1UyJoMp4YLEuNSfAP+JcXn/tWtIaxVXM" crossorigin="anonymous"></script>
   

    <link rel="stylesheet" href="styles.css">

    <title>Load Matresses Form</title>
</head>
<body>
    <section class="small-container">
        <header>Loaded Mattresses Tracker</header>
        <?php
        if(isset($_GET['id']))
        {
            $user_id = $_GET['id'];
            $users = "SELECT * FROM truckloadinformationtable WHERE id= '$user_id' ";
            $users_run = mysqli_query($con, $users);

            if(mysqli_num_rows($users_run) > 0)
            {
                foreach($users_run as $user)
                {
        ?>
        <form method="post" enctype="multipart/form-data" id="add_form" class="form">
            <input type="hidden" name="id" value="<?= $user['id']; ?>">
            <input type="hidden" name="totalMattresses" id="totalMattresses" value="">
            <input type="hidden" name="concatenatedData" value="">

            <div id="stacks" class="input-box"> 
                <input type="number" name="stacks[]" class="form-control stacks" placeholder="Number of Mattresses" required>
            </div>

            <br>

            <div class="controls">
                <a href="#" id="add_more_fields"> <i class="fa fa-plus"></i>Add More</a>
                <a href="#" id="remove_fields"> <i class="fa fa-plus"></i>Remove Fields</a>
            </div>
            
            <br>

            <div id="file-upload" class="input-box">
                <label class="file-label">
                    <input class="file-input" type="file" name="image" accept="image/*" required id="image">
                    <span class="label-file">Choose a file…</span>
                    <span class="file-name" id="file-name">No file uploaded</span>
                </label>
            </div> 

            <div class="form-btns" id="driver-btns">
                <a href="userIndex.php" class="cancelbtn">Cancel</a>
                <input type="submit" class="submitbtn" value="Submit">
            </div>

        </form>
        <?php
                }
            } else {
        ?>
            <h4> No record found </h4>
        <?php
            }
        }
        else {
        ?>
        <h4> No formId provided in the URL </h4>
        <?php
        }

        mysqli_close($con);
        ?>
    </section>
    <script>
    // Move totalMattresses function outside $(document).ready()
    function totalMattresses() {
        var inputTags = document.getElementsByName('stacks[]');
        var totalMattresses = 0;

        for (var i = 0; i < inputTags.length; i++) {
            var inputValue = parseInt(inputTags[i].value) || 0;
            totalMattresses += inputValue;
        }

        // Set the totalMattresses value to the hidden input
        document.getElementById('totalMattresses').value = totalMattresses;
    }

    $(document).ready(function() {
        $("#add_more_fields").click(function(e) {
            e.preventDefault();
            var newField = $('<input type="number" name="stacks[]" class="form-control stacks" placeholder="Number of Matresses" required>');
            $("#stacks").append(newField);
        });

        $("#remove_fields").click(function(e) {
            e.preventDefault();
            var input_tags = $("#stacks").find('input');
            if(input_tags.length > 1){
                input_tags.last().remove();
            }
        });

        const fileInput = document.querySelector('#file-upload input[type=file]');
        fileInput.onchange = () => {
            if (fileInput.files.length > 0) {
                const fileName = document.querySelector('#file-upload .file-name');
                fileName.textContent = fileInput.files[0].name;
            }
        };

        $("#add_form").submit(function(e) {
            e.preventDefault();
            totalMattresses(); 
            let concatenatedData = "";

            // Concatenate data from stacks[] input fields
            $("input[name='stacks[]']").each(function() {
                concatenatedData += $(this).val() + " ";
            });

            // Add concatenatedData to the form data
            let formData = new FormData($(this)[0]);
            formData.append('concatenatedData', concatenatedData);

            // Set the 'submit' key to indicate the form submission
            formData.append('submit', 'submit');

            // Add the formId to formData
            var form_id = <?php echo json_encode($user['id']); ?>;
            formData.append('form_id', form_id);

            // Debugging: Log formData
            console.log('formData:', formData);
          $.ajax({
            url: '',
            method: 'post',
            data: formData,
            contentType: false,
            processData: false,
            success: function(response) {
                console.log('AJAX Success:', response);
                $('#successModal').modal('show'); // Show the modal
            },
            error: function(jqXHR, textStatus, errorThrown) {
                console.log('AJAX Error:', textStatus, errorThrown);
            }
        });
    });
});
    </script>

<div class='modal fade' id='successModal' tabindex='-1' aria-labelledby='successModalLabel' aria-hidden='true'>
    <div class='modal-dialog modal-dialog-centered'>
        <div class='modal-content'>
            <div class='modal-header'>
                <h5 class='modal-title' id='successModalLabel'>Success</h5>
                <button type='button' class='btn-close' data-bs-dismiss='modal' aria-label='Close' onclick='window.location.href="userIndex.php"'></button>
            </div>
            <div class='modal-body'>
                The form was completed successfully
            </div>
        </div>
    </div>
</div>


</body>
</html>