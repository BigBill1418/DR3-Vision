<?php

session_start();
include "connection.php";
include "auth.php";

$DR3Site = "";
$receiveFrom = "";
$BOL = "";
$ForkliftDriver = "";
$loadDate = "";

$errorMessage = "";
$successMessage = "";

if ($_SERVER['REQUEST_METHOD'] == 'POST') {
    $DR3Site = htmlspecialchars($_POST["DR3Site"]);
    $receivedFrom = htmlspecialchars($_POST["receivedFrom"]);
    $BOL = htmlspecialchars($_POST["BOL"]);
    $forkliftDriver = htmlspecialchars($_POST["forkliftDriver"]);
    $loadDate = htmlspecialchars($_POST["loadDate"]);

    do {
        if (empty($DR3Site) || empty($receivedFrom) || empty($BOL) || empty($forkliftDriver) || empty($loadDate)) {
            $errorMessage = "All the fields are required";
            break;
        }

        $sql = "INSERT INTO truckloadinformationtable (DR3Site, receivedFrom, BOL, forkliftDriver, loadDate) VALUES (?, ?, ?, ?, ?)";
        $stmt = $con->prepare($sql);

        if ($stmt) {
            $stmt->bind_param("sssss", $DR3Site, $receivedFrom, $BOL, $forkliftDriver, $loadDate);
            $stmt->execute();

            $successMessage = "Task added correctly";

        } else {
            $errorMessage = "Failed to prepare statement: " . $con->error;
        }

        $stmt->close();
    } while (false);
}

?>

<!DOCTYPE html>
<html lang="en">

<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>Create Task</title>
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
    <section class="container">
        <header>New Form</header>

        <?php
            if (!empty($successMessage)) {
                echo "
                    <!-- Success Modal -->
                    <div class='modal fade' id='successModal' tabindex='-1' aria-labelledby='successModalLabel' aria-hidden='true'>
                        <div class='modal-dialog modal-dialog-centered'>
                            <div class='modal-content'>
                                <div class='modal-header'>
                                    <h5 class='modal-title' id='successModalLabel'>Success</h5>
                                    <button type='button' class='btn-close' data-bs-dismiss='modal' aria-label='Close' onclick='window.location.href=\"AdminIndex.php\"'></button>
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

        <form method="post" enctype="multipart/form-data" class="form">
            <div class="input-box">
                <label for="DR3Site">DR3 Site:</label><br>
                <input type="text" name="DR3Site" placeholder="DR3 Site" required value="<?php echo $DR3Site; ?>"><br><br>
            </div>

            <div class="input-box">
                <label for="receivedFrom">Received From:</label><br>
                <input type="text" name="receivedFrom" placeholder="Received From" required value="<?php echo $receiveFrom; ?>"><br><br>
            </div>

            <div class="input-box">
                <label for="BOL/Trailer">BOL/ Trailer Number:</label><br>
                <input type="text" name="BOL" placeholder="BOL/ Trailer Number" required value="<?php echo $BOL; ?>"> <br><br>
            </div>

            <div class="input-box">
                <label for="ForkliftDriver">Assign to:</label><br>
                <input type="text" name="forkliftDriver" placeholder="Forklift Driver" required value="<?php echo $ForkliftDriver; ?>"> <br><br>
            </div>

            <div class="input-box">
                <label for="loadDate">Load Date:</label><br>
                <input type="date" name="loadDate" required value="<?php echo $loadDate; ?>"><br><br>
            </div>


            <div class=form-btns>
                <a href="adminIndex.php" class="cancelbtn">Cancel</a>
                <input type="submit" class="submitbtn" value="Submit">
            </div>


        </form>
    </section>
</body>

</html>
