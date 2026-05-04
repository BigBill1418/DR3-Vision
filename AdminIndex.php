<?php
session_start();
include "auth.php"
?>

<!DOCTYPE html>
<html>
<head>
    <title>Dashboard</title>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1">
    <link rel="stylesheet" href="styles.css" />
</head>

<body>
    <section class="small-container"  >
        <header>Dashboard</header>
        
        <div class="dashboard-buttons">
            <button onclick="location.href='createUser.php'" class="button">Create User</button>
            <button onclick="location.href='viewUsers.php'" class="button">View Users</button>
            <button onclick="location.href='createTask.php'" class="button">Create New Task</button>
            <button onclick="location.href='viewTasks.php'" class="button">View Tasks</button>
            <button onclick = "location.href='logout.php';" class="button"> Log Out </button>
        </div>
    </section>
</body>
</html>
