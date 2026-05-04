<?php

session_start();

include "connection.php";

$loginError = false;

if (!isset($_POST['username'], $_POST['password'])) {
    exit('Please fill both the username and password fields!');
}

if ($stmt = $con->prepare('SELECT id, password, role FROM users WHERE username = ?')) {
    // Bind parameters (s = string, i = int, b = blob, etc), in our case the username is a string so we use "s"
    $stmt->bind_param('s', $_POST['username']);
    $stmt->execute();
    // Store the result so we can check if the account exists in the database.
    $stmt->store_result();

    if ($stmt->num_rows > 0) {
        $stmt->bind_result($id, $password, $role);
        $stmt->fetch();
        // Account exists, now we verify the password.
        // Note: remember to use password_hash in your registration file to store the hashed passwords.
        if (password_verify($_POST['password'], $password)) {
            
            // Verification success! User has logged-in!
            // Create sessions, so we know the user is logged in, they basically act like cookies but remember the data on the server.
            session_regenerate_id();
            $_SESSION['loggedin'] = TRUE;
            $_SESSION['name'] = $_POST['username'];
            $_SESSION['id'] = $id;
            $_SESSION['role'] = $role;

            if ($role == 'Administrator') {
                header('Location: AdminIndex.php');
            } else {
                header('Location: userIndex.php');
            }
            exit();

        } else {
            // Incorrect password
            $loginError = true;
        }
    } else {
        // Incorrect username
        $loginError = true;
    }

    // Close the statement
    $stmt->close();
} else {
    // Handle the prepared statement error if any
    echo 'Error in prepared statement: ' . $con->error;
}

// Close the connection
mysqli_close($con);
?>

<?php
if ($loginError) {
    echo "<script>alert('Incorrect username and/or password');</script>";
}
?>


