<!DOCTYPE html>
<html lang="en">

<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>View Tasks</title>
    <link href="https://cdn.jsdelivr.net/npm/bootstrap@5.0.2/dist/css/bootstrap.min.css" rel="stylesheet"
        integrity="sha384-EVSTQN3/azprG1Anm3QDgpJLIm9Nao0Yz1ztcQTwFspd3yD65VohhpuuCOmLASjC"
        crossorigin="anonymous">
    <script src="https://cdn.jsdelivr.net/npm/bootstrap@5.0.2/dist/js/bootstrap.bundle.min.js"></script>
        <link rel="stylesheet" href="styles.css">
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
    <section class="container" id="tasks-container">
        <h2> Tasks</h2>
        <br>
        <div class="table-responsive">
        <table class="table">
            <thead>
                <tr>
                    <th>Driver</th>
                    <th>DR3 Site</th>
                    <th>Received From</th>
                    <th>Action</th> 
                </tr>
            </thead>
            <tbody>
                <?php 
                session_start();
                include "auth.php";
                include "connection.php";
                $sql = "SELECT * FROM truckloadinformationtable";
                $result = $con->query($sql);

                if(!$result){
                    die("Invalid query: " . $con->error);
                }

                while ($row = $result->fetch_assoc()){
                    echo "
                    <tr>
                        <td>$row[forkliftDriver]</td>
                        <td>$row[DR3Site]</td>
                        <td>$row[receivedFrom]</td>
                        <td>
                            <a href='viewTaskDetail.php?id=$row[id]' >View Details</a>
                        </td>
                    </tr>";
                }
                ?>
            </tbody>
        </table>
            </div>
        <button onclick = "window.location.href='adminIndex.php';" class="backbtn"> Back </button>
        </section>
</body>

</html>
