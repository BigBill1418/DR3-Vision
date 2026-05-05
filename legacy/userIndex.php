<?php

session_start();

include "connection.php";

// Assuming you have a session variable 'current_user' that stores the current user's username
$current_user = $_SESSION['name'];

// Use a parameterized query to avoid SQL injection
$query = "SELECT * FROM truckloadinformationtable WHERE forkliftDriver = ? AND status != 'complete'";
$stmt = mysqli_prepare($con, $query);

// Bind the parameter
mysqli_stmt_bind_param($stmt, 's', $current_user);

// Execute the query
mysqli_stmt_execute($stmt);

// Get the result
$result = mysqli_stmt_get_result($stmt);

?>

<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta http-equiv="X-UA-Compatible" content="IE=edge">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>Tasks</title>
    <link href="https://cdn.jsdelivr.net/npm/bootstrap@5.0.2/dist/css/bootstrap.min.css" rel="stylesheet" integrity="sha384-EVSTQN3/azprG1Anm3QDgpJLIm9Nao0Yz1ztcQTwFspd3yD65VohhpuuCOmLASjC" crossorigin="anonymous">
    <link rel="stylesheet" href="styles.css">
    <style>
        .card {
            border: none;
            border-radius: 10px;
            box-shadow: 0 4px 8px rgba(0, 0, 0, 0.1);
        }
        .card-header {
            border-radius: 10px 10px 0 0;
        }
        .card-body {
            padding: 20px;
        }
        .table {
            border-radius: 10px;
        }
        .table th, .table td {
            vertical-align: middle;
        }
        .bg-dark {
            background-color: #343a40 !important;
        }


    </style>
</head>
<body>
    <section class="container mt-5">
        <div class="row">
            <div class="col">
                <div class="card">
                    <div class="card-header">
                        <h2 class="display-6 text-center">Tasks</h2>
                    </div>
                    <div class="card-body">
                        <div class="table-responsive">
                            <table class="table table-bordered text-center">
                                <thead>
                                    <tr class="bg-dark text-white">
                                        <th>BOL</th>
                                        <th>DR3 Site</th>
                                        <th>Received From</th>
                                        <th>Load Date</th>
                                        <th>Action</th>
                                    </tr>
                                </thead>
                                <tbody>
                                    <?php
                                    while ($row = mysqli_fetch_assoc($result)) {
                                    ?>
                                        <tr>
                                            <td><?php echo $row['BOL']; ?></td>
                                            <td><?php echo $row['DR3Site']; ?></td>
                                            <td><?php echo $row['receivedFrom']; ?></td>
                                            <td><?php echo $row['loadDate']; ?></td>
                                            <td>
                                                <a href="driverform.php?id=<?php echo $row['id']; ?>" class="cancelbtn">Edit</a>
                                                <a href="completeTask.php?id=<?php echo $row['id']; ?>" class="submitbtn">Complete</a>
                                            </td>
                                        </tr>
                                    <?php
                                    }
                                    ?>
                                </tbody>
                            </table>
                        </div>
                        <a href="logout.php" class="submitbtn">Log Out</a>
                    </div>
                </div>
            </div>
        </div>
    </section>
</body>
</html>

