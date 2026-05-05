<?php

session_start();

include "connection.php";

$loginError = false;
$errorMsg = '';

if (isset($_POST['login-btn'])) {
    if (!isset($_POST['username'], $_POST['password'])) {
        $errorMsg = 'Please fill both the username and password fields!';
    } else {
        if ($stmt = $con->prepare('SELECT id, password, role FROM users WHERE username = ?')) {
            // Bind parameters
            $stmt->bind_param('s', $_POST['username']);
            $stmt->execute();
            // Store the result so we can check if the account exists in the database.
            $stmt->store_result();

            if ($stmt->num_rows > 0) {
                $stmt->bind_result($id, $password, $role);
                $stmt->fetch();
                // Account exists, now we verify the password.
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
                    $errorMsg = 'Incorrect username and/or password';
                }
            } else {
                // Incorrect username
                $loginError = true;
                $errorMsg = 'Incorrect username and/or password';
            }

            $stmt->close();
        } else {
            // Handle the prepared statement error if any
            $errorMsg = 'Error in prepared statement: ' . $con->error;
        }
    }
}

mysqli_close($con);
?>

<!DOCTYPE html>
<html>
<head>
    <title>Log in</title>
    <meta charset="UTF-8">
    <title>Mattress Load Tracker</title>
    <meta name="viewport" content="width=device-width, initial-scale=1">
    <link href="https://cdn.jsdelivr.net/npm/bootstrap@5.0.2/dist/css/bootstrap.min.css" rel="stylesheet" crossorigin="anonymous">
    <link rel="stylesheet" href="styles.css" />
</head>

<body>
    <section class="small-container">
        <header>Log In</header>
        <form action="<?php echo htmlspecialchars($_SERVER["PHP_SELF"]);?>" method="post" class="form" >

            <div class="input-box">
                <label for="password">Username</label>
                <input type="text" placeholder="Username" name="username" required>
            </div>
            <div class="input-box">
                <label for="password">Password</label>
                <input type="password" placeholder="Password" name="password" required>
            </div>

            <?php if ($loginError): ?>
                <!-- Bootstrap Modal for displaying error message -->
                <div class="modal fade" id="errorModal" tabindex="-1" aria-labelledby="errorModalLabel" aria-hidden="true">
                    <div class="modal-dialog">
                        <div class="modal-content">
                            <div class="modal-header">
                                <h5 class="modal-title" id="errorModalLabel">Error</h5>
                                <button type="button" class="btn-close" data-bs-dismiss="modal" aria-label="Close"></button>
                            </div>
                            <div class="modal-body">
                                <?php echo $errorMsg; ?>
                            </div>
                            <div class="modal-footer">
                                <button type="button" class="btn btn-secondary" data-bs-dismiss="modal">Close</button>
                            </div>
                        </div>
                    </div>
                </div>
                <script>
                    // Script to display the modal automatically
                    window.onload = function() {
                        var myModal = new bootstrap.Modal(document.getElementById('errorModal'), {
                            keyboard: false
                        });
                        myModal.show();
                    };
                </script>
            <?php endif; ?>

            <br>
            <div>
                <input type="submit" value="Log In" class="button" name="login-btn">
            </div>
        </form>
    </section>

    <script src="https://cdnjs.cloudflare.com/ajax/libs/bootstrap/5.0.2/js/bootstrap.bundle.min.js" crossorigin="anonymous"></script>
</body>
</html>
