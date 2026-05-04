<?php
include "connection.php";

$username = $password = $confirm_password = $role = "";
$username_err = $password_err = $confirm_password_err = $role_err = "";
$successMessage = "";

// Check if the form is submitted
if ($_SERVER["REQUEST_METHOD"] == "POST") {

    // Get the user ID from the hidden field
    $user_id = $_POST['user_id'];

    // Validate username
    if (empty(trim($_POST["username"]))) {
        $username_err = "Please enter a username.";
    } elseif (!preg_match('/^[a-zA-Z0-9_.]+$/', trim($_POST["username"]))) {
        $username_err = "Username can only contain letters, numbers, dots, and underscores.";
    } else {
        // Check if the username already exists in the database for other users
        $check_username_query = "SELECT id FROM users WHERE username = ? AND id != ?";
        if ($check_stmt = $con->prepare($check_username_query)) {
            $check_stmt->bind_param("si", $param_username, $user_id);
            $param_username = trim($_POST["username"]);
            
            if ($check_stmt->execute()) {
                $check_stmt->store_result();
                
                if ($check_stmt->num_rows > 0) {
                    $username_err = "This username is already taken.";
                } else {
                    $username = trim($_POST["username"]);
                }
            } else {
                echo "Oops! Something went wrong. Please try again later.";
            }
    
            // Close the statement
            $check_stmt->close();
        }
    }

    // Validate password
    if (empty(trim($_POST["password"]))) {
        $password_err = "Please enter a password.";
    } else {
        $password = trim($_POST["password"]);
    }

    // Validate confirm password
    if (empty(trim($_POST["confirm_password"]))) {
        $confirm_password_err = "Please confirm the password.";
    } else {
        $confirm_password = trim($_POST["confirm_password"]);
        if ($password != $confirm_password) {
            $confirm_password_err = "Passwords do not match.";
        }
    }

    // Validate role
    $role = $_POST["role"];
    if (empty($role)) {
        $role_err = "Please select a role.";
    }

    if (empty($username_err) && empty($password_err) && empty($confirm_password_err) && empty($role_err)) {
        // Passwords match, proceed with the update
        $update_query = "UPDATE users SET username=?, password=?, role=? WHERE id=?";
        if ($stmt = $con->prepare($update_query)) {
            // Hash the password before saving it in the database
            $hashed_password = password_hash($password, PASSWORD_DEFAULT);

            // Execute the prepared statement
            if ($stmt) {
                $stmt->bind_param("sssi", $username, $hashed_password, $role, $user_id);
                $stmt->execute();
                $successMessage = "Successful Update";
            } else {
                echo "Oops! Something went wrong. Please try again later.";
            }

            // Close the statement
            $stmt->close();
        }
    }
}

// Close the database connection
$con->close();
?>


<?php 
    include "connection.php";

    $sql = "SELECT * FROM users";
    $result = $con->query($sql);

?>

<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <title>Edit User</title>
    <link rel="stylesheet" href="styles.css">
    <link href="https://cdn.jsdelivr.net/npm/bootstrap@5.0.2/dist/css/bootstrap.min.css" rel="stylesheet" crossorigin="anonymous">
    <script src="https://ajax.googleapis.com/ajax/libs/jquery/3.5.1/jquery.min.js"></script>
    <script src="https://cdn.jsdelivr.net/npm/bootstrap@5.0.2/dist/js/bootstrap.bundle.min.js" integrity="sha384-MrcW6ZMFYlzcLA8Nl+NtUVF0sA7MsXsP1UyJoMp4YLEuNSfAP+JcXn/tWtIaxVXM" crossorigin="anonymous"></script>
    <style>
        body {
            min-height: 100vh;
            display: flex;
            align-items: center;
            justify-content: center;
            background: #ED1b24;
            padding: 0 20px;
        }
    </style>
</head>
<body>
    <section class = "container">
        <header>Edit User</header>
        <p>Please fill this form to edit an existing account.</p>

        <?php
            if (!empty($successMessage)) {
                echo "
                    <!-- Success Modal -->
                    <div class='modal fade' id='successModal' tabindex='-1' aria-labelledby='successModalLabel' aria-hidden='true'>
                        <div class='modal-dialog modal-dialog-centered'>
                            <div class='modal-content'>
                                <div class='modal-header'>
                                    <h5 class='modal-title' id='successModalLabel'>Success</h5>
                                    <button type='button' class='btn-close' data-bs-dismiss='modal' aria-label='Close' onclick='window.location.href=\"viewUsers.php\"'></button>
                                </div>
                                <div class='modal-body'>
                                    $successMessage
                                </div>
                            </div>
                        </div>
                    </div>
                ";
                echo "
                    <script>
                        $(document).ready(function() {
                            $('#successModal').modal('show');
                        });
                    </script>
                ";
            }
        ?>

        <?php

        if(isset($_GET['id']))
        {
            $user_id = $_GET['id'];
            $users = "SELECT * FROM users WHERE id= '$user_id' ";
            $users_run = mysqli_query($con, $users);

            if(mysqli_num_rows($users_run) > 0)
            {
                foreach($users_run as $user)
                {
                    ?>


                <form  method="post" class="form">


                <input type="hidden" name="user_id" value = "<?=$user['id']; ?> ">
                    <div class="input-box">
                        <label>Username</label>
                        <input type="text" name="username"  required class="form-control <?php echo (!empty($username_err)) ? 'is-invalid' : ''; ?>" value="<?=$user['username']; ?>">
                        <span class="invalid-feedback"><?php echo $username_err; ?></span>
                    </div>    
                    <div class="input-box">
                        <label>Password</label>
                        <input type="password" required name="password" class="form-control <?php echo (!empty($password_err)) ? 'is-invalid' : ''; ?> ">
                        <span class="invalid-feedback"><?php echo $password_err; ?></span>
                    </div>
                    <div class="input-box">
                        <label>Confirm Password</label>
                        <input type="password" required name="confirm_password" class="form-control <?php echo (!empty($confirm_password_err)) ? 'is-invalid' : ''; ?> " >
                        <span class="invalid-feedback"><?php echo $confirm_password_err; ?></span>
                    </div>
                    <div class="input-box">
                        <label for="role">Users role:</label>
                        <select name="role" id="role" class="form-control" required>
                            <option value="">--Select Role--</option>
                            <option value="Administrator" <?=$user['role']=="Administrator" ? "selected":""?> >Administrator</option>
                            <option value="User" <?=$user['role']=="User" ? "selected":""?> >User</option>
                        </select>
                    </div>

                    <div class = form-btns>
                        <a href="adminIndex.html" class="cancelbtn">Cancel</a>
                        <input type="submit" class="submitbtn" value="Submit" name="update_user">
                </div>

                </form>

                <?php
                }
            }
            else
            {
                ?>
                <h4> No record found </h4>
                <?php
            }

        }
        mysqli_close($con);
        ?>

    </section>    
</body>
</html>