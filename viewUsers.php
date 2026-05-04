<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>Users</title>
    <link href="https://cdn.jsdelivr.net/npm/bootstrap@5.0.2/dist/css/bootstrap.min.css" rel="stylesheet" integrity="sha384-EVSTQN3/azprG1Anm3QDgpJLIm9Nao0Yz1ztcQTwFspd3yD65VohhpuuCOmLASjC" crossorigin="anonymous">
    <script src="https://cdn.jsdelivr.net/npm/bootstrap@5.0.2/dist/js/bootstrap.bundle.min.js" integrity="sha384-MrcW6ZMFYlzcLA8Nl+NtUVF0sA7MsXsP1UyJoMp4YLEuNSfAP+JcXn/tWtIaxVXM" crossorigin="anonymous"></script>
    <link rel="stylesheet" href="styles.css">
</head>
<body>
    <div class="container my-5">
        <h2> Users</h2>
        <br>
        <div class="table-responsive">
        <table class="table">
            <thead>
                <tr>
                    <th>User</th>
                    <th>Role</th>
                    <th>Action</th>
                </tr>
            </thead>
            <tbody>
                <?php 
                session_start();
                include "connection.php"; 
                include "auth.php";

                $sql = "SELECT * FROM users";
                $result = $con->query($sql);


                if(!$result){
                    die("Invalid query: " . $con->error);
                }

                while ($row = $result->fetch_assoc()){
                    echo"
                    <tr>
                    <td>$row[username]</td>
                    <td>$row[role]</td>
                    <td>
                        <a class='btn btn-primary btn-sm' href='editUser.php?id=$row[id]'>Edit</a>
                        <a class='btn btn-danger btn-sm' href='deleteUser.php?id=$row[id]'>Delete</a>
                    </td>
                    </tr>
                    ";

                }
                ?>

            </tbody>

        </table>
        </div>
 
        <a href="adminIndex.php" class="backbtn"> Back </a>
    </div>
</body>
</html>