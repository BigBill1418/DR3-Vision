<?php

// If user is logged in
if (!isset($_SESSION['loggedin']) || $_SESSION['loggedin'] !== true) {
    header("Location: login.php");
    exit;
}

// If user == admin
if (!isset($_SESSION['role']) || $_SESSION['role'] !== 'Administrator') {
    echo "You are not authorized to access this page.";
    exit;
}
?>

