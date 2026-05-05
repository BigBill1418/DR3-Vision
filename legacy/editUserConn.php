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

            // Bind parameters to the prepared statement
            //$stmt->bind_param("sssi", $username, $hashed_password, $role, $user_id);

            // Execute the prepared statement
            if ($stmt) {
                $stmt->bind_param("sssi", $username, $hashed_password, $role, $user_id);

                $stmt->execute();
                $successMessage = "Successful Update";
                //header("location: viewUsers.php"); // Redirect to the page where you view all users
            } else {
                echo "Oops! Something went wrong. Please try again later.";
            }

            // Close the statement
            $stmt->close();
        }
    } else {
        // Display an error message for other validation errors
        if (!empty($confirm_password_err)) {
            echo $confirm_password_err;
        } elseif (!empty($username_err)) {
            echo $username_err;
        } else {
            echo "Oops! Something went wrong. Please check the form for errors.";
        }
    }
}

// Close the database connection
$con->close();
?>
